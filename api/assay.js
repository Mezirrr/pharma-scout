import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Tier limits – Free now 10, plus hidden super-user
const TIER_LIMITS = { Free: 10, Mini: 50, Max: 1000 };
const PROFILE_SYNTHESIS_EVERY = 5;

// Smart fetch with timeout & retry (unchanged)
async function fetchWithRetry(url, options = {}, retries = 2, timeoutMs = 8000) {
  for (let i = 0; i <= retries; i++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeoutId);
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status} – ${body.slice(0, 200)}`);
      }
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      if (i === retries) throw error;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

function currentPeriod() {
  return new Date().toISOString().slice(0, 7);
}

async function maybeUpdateResearcherProfile(userId, newSearchCount) {
  // ... (unchanged, but now with error logging)
  if (newSearchCount % PROFILE_SYNTHESIS_EVERY !== 0) return;

  const { data: recent } = await supabaseAdmin
    .from('search_history')
    .select('target_searched, goal_input')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(5);

  if (!recent?.length) return;

  const historyText = recent
    .map((s, i) => `${i + 1}. Target(s): ${s.target_searched} | Goal: ${s.goal_input || 'n/a'}`)
    .join('\n');

  const system = `You write extremely terse researcher‑focus summaries. Given recent search queries, output ONLY a single plain‑text synthesis, ≤50 words. No preamble, no JSON.`;

  try {
    const res = await fetchWithRetry('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: historyText }
        ]
      })
    }, 1, 6000);

    const data = await res.json();
    const synth = data?.choices?.[0]?.message?.content?.trim();
    if (synth) {
      await supabaseAdmin.from('profiles').update({ researcher_profile: synth }).eq('id', userId);
    }
  } catch (e) {
    console.error('Profile synthesis failed (non-critical):', e.message);
  }
}

// Helper to extract JSON from a string that might contain markdown fences
function extractJSON(str) {
  // Remove possible markdown code fences
  let cleaned = str.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  // Find the outermost { ... }
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1) throw new Error('No JSON braces found');
  return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
}

export default async function handler(req, res) {
  // ---------------------------- LOGGING HEADER ----------------------------
  const requestId = Math.random().toString(36).slice(2, 8);
  console.log(`[${requestId}] Incoming assay request`);

  if (req.method !== 'POST') {
    console.warn(`[${requestId}] Wrong method`);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 1. Auth
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    console.warn(`[${requestId}] No Authorization header`);
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const token = authHeader.replace('Bearer ', '');
  console.log(`[${requestId}] Verifying token...`);

  let user;
  try {
    const { data, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !data.user) {
      console.error(`[${requestId}] Auth error:`, authError);
      return res.status(401).json({ error: 'Invalid session.' });
    }
    user = data.user;
    console.log(`[${requestId}] Auth OK – user: ${user.email}`);
  } catch (e) {
    console.error(`[${requestId}] Auth exception:`, e);
    return res.status(500).json({ error: 'Authentication service error.' });
  }

  // 2. Profile lookup
  let profile;
  try {
    const { data, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();
    if (profileError || !data) {
      console.error(`[${requestId}] Profile missing:`, profileError);
      return res.status(403).json({ error: 'Profile not found.' });
    }
    profile = data;
    console.log(`[${requestId}] Profile loaded – tier: ${profile.tier}, used: ${profile.assays_used_this_month}`);
  } catch (e) {
    console.error(`[${requestId}] Profile fetch exception:`, e);
    return res.status(500).json({ error: 'Database error.' });
  }

  // ==== Hidden unlimited access for special email ====
  const isSuperUser = (user.email === 'mezirrr@protonmail.com');
  if (isSuperUser) {
    console.log(`[${requestId}] Super user detected – bypassing tier limits.`);
  }

  // 3. Tier limit check (skip if super user)
  if (!isSuperUser) {
    const period = currentPeriod();
    const usedThisMonth = profile.usage_period === period ? profile.assays_used_this_month : 0;
    const limit = TIER_LIMITS[profile.tier] || TIER_LIMITS.Free;
    console.log(`[${requestId}] Usage: ${usedThisMonth}/${limit} (period ${period})`);
    if (usedThisMonth >= limit) {
      console.warn(`[${requestId}] Limit exceeded`);
      return res.status(403).json({
        error: `Monthly limit reached (${profile.tier}: ${limit}). Please upgrade.`
      });
    }
  }

  const { target, goal, typeLabel } = req.body;
  if (!target) {
    console.warn(`[${requestId}] No target in body`);
    return res.status(400).json({ error: 'No target provided.' });
  }

  const targetsArray = target.split(',').map(t => t.trim()).filter(Boolean);
  if (targetsArray.length === 0) {
    console.warn(`[${requestId}] Empty targets array`);
    return res.status(400).json({ error: 'No valid targets.' });
  }

  const targetsHeading = targetsArray.join(', ');
  const s2ApiKey = "s2k-zRgzPNUsqrylk6ST4j78YbPFDcq74woh6HR4Uawp";

  try {
    // ===================== PHASE 1: Enhancer =====================
    console.log(`[${requestId}] Phase 1: Enhancer start`);
    let enhancedGoal = goal || 'General pharmacological profile';
    let optimizedQueries = {};

    const enhancerSystem = `You optimize biomedical search queries. Return ONLY valid JSON:
{
  "enhancedGoal": "technical reframing (max 2 sentences)",
  "optimizedQueries": { "TargetName": "keyword string" }
}`;

    const enhancerUser = `Targets: ${targetsHeading}\nRaw Goal: ${goal || 'General info'}`;

    try {
      const enhRes = await fetchWithRetry('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model: 'openai/gpt-oss-120b',
          messages: [
            { role: 'system', content: enhancerSystem },
            { role: 'user', content: enhancerUser }
          ]
        })
      }, 2, 6000);

      const enhData = await enhRes.json();
      console.log(`[${requestId}] Enhancer response received`);
      const raw = enhData.choices[0].message.content.trim();
      console.log(`[${requestId}] Enhancer raw (first 200 chars):`, raw.slice(0, 200));

      try {
        const parsed = extractJSON(raw);
        enhancedGoal = parsed.enhancedGoal || enhancedGoal;
        optimizedQueries = parsed.optimizedQueries || {};
        console.log(`[${requestId}] Enhancer parsed OK`);
      } catch (parseErr) {
        console.warn(`[${requestId}] Enhancer JSON parse failed, using defaults:`, parseErr.message);
      }
    } catch (e) {
      console.error(`[${requestId}] Enhancer network error:`, e.message);
      // Continue with defaults
    }

    // ===================== PHASE 2: Semantic Scholar =====================
    console.log(`[${requestId}] Phase 2: Semantic Scholar`);
    let allPapers = [];
    let fallbackTriggered = false;

    for (let i = 0; i < targetsArray.length; i++) {
      const singleTarget = targetsArray[i];
      if (i > 0) await new Promise(r => setTimeout(r, 1200));

      let query = optimizedQueries[singleTarget] || `${singleTarget} ${enhancedGoal}`;
      let s2Url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=15&fields=paperId,title,url,year,abstract`;

      try {
        console.log(`[${requestId}] S2 query for "${singleTarget}"`);
        let s2Res = await fetchWithRetry(s2Url, { headers: { 'x-api-key': s2ApiKey } }, 1, 6000);
        let s2Data = await s2Res.json();
        let papers = s2Data.data || [];

        if (papers.length === 0) {
          console.log(`[${requestId}] No results, trying fallback`);
          fallbackTriggered = true;
          await new Promise(r => setTimeout(r, 1200));
          const fallbackUrl = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(singleTarget)}&limit=15&fields=paperId,title,url,year,abstract`;
          s2Res = await fetchWithRetry(fallbackUrl, { headers: { 'x-api-key': s2ApiKey } }, 1, 6000);
          s2Data = await s2Res.json();
          papers = s2Data.data || [];
        }

        const mapped = papers.map(p => ({
          title: p.title || 'Untitled',
          url: p.url || (p.paperId ? `https://www.semanticscholar.org/paper/${p.paperId}` : ''),
          year: p.year || 'Unknown',
          abstract: p.abstract ? p.abstract.substring(0, 400) + '...' : '',
          associatedTarget: singleTarget
        })).filter(p => p.url);

        allPapers.push(...mapped);
      } catch (err) {
        console.error(`[${requestId}] S2 fetch failed for "${singleTarget}":`, err.message);
      }
    }

    // Deduplicate
    const seen = new Set();
    const uniquePapers = allPapers.filter(p => {
      if (!p.url || seen.has(p.url)) return false;
      seen.add(p.url);
      return true;
    }).slice(0, 35);
    console.log(`[${requestId}] Total unique papers after dedup: ${uniquePapers.length}`);

    // ===================== PHASE 3: Synthesis =====================
    console.log(`[${requestId}] Phase 3: Synthesis`);
    const researcherContext = profile.researcher_profile
      ? `\n\nResearcher Focus Profile (use to bias analysis subtly): ${profile.researcher_profile}`
      : '';

    const systemPrompt = `You are an elite biochemical intelligence engine. Return ONLY valid JSON (no markdown) following exactly this schema:
{
  "directResponse": "string (hyper‑analytical synthesis, technical tone)",
  "followUpOptions": ["string (max 12 words each)", ...],
  "results": [
    {
      "title": "paper title",
      "url": "paper url",
      "source": "Semantic Scholar",
      "year": "year",
      "relevance": "string (≤18 words linking to target matrix)",
      "studyType": "In Vitro | In Vivo | Human"
    }
  ]
}
Targets: ${targetsHeading}
Original Goal: ${goal || 'General'}
Enhanced Context: ${enhancedGoal}
Fallback active: ${fallbackTriggered}
Papers: ${JSON.stringify(uniquePapers)}
${researcherContext}`;

    const groqRes = await fetchWithRetry('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: 'Filter and return JSON.' }
        ]
      })
    }, 2, 12000);

    const groqData = await groqRes.json();
    console.log(`[${requestId}] Groq synthesis response received`);
    const rawText = groqData.choices[0].message.content.trim();
    console.log(`[${requestId}] Groq raw (first 300 chars):`, rawText.slice(0, 300));

    let finalJson;
    try {
      finalJson = extractJSON(rawText);
      console.log(`[${requestId}] JSON parsed successfully`);
    } catch (parseErr) {
      console.error(`[${requestId}] Groq JSON parse failed:`, parseErr.message);
      console.error(`[${requestId}] Full raw response:`, rawText);
      return res.status(500).json({
        error: 'AI returned invalid data format. Please try again.'
      });
    }

    finalJson.isFallback = fallbackTriggered;
    if (finalJson.results) {
      finalJson.results.forEach(r => { r.source = 'Semantic Scholar'; });
    }

    // ===================== UPDATE USAGE =====================
    const period = currentPeriod();
    const usedThisMonth = (profile.usage_period === period ? profile.assays_used_this_month : 0);
    const newCount = (profile.search_count || 0) + 1;

    console.log(`[${requestId}] Updating usage: +1, total this month ${usedThisMonth + 1}`);
    await supabaseAdmin.from('profiles').update({
      assays_used_this_month: usedThisMonth + 1,
      usage_period: period,
      search_count: newCount
    }).eq('id', user.id);

    await supabaseAdmin.from('search_history').insert([{
      user_id: user.id,
      target_searched: targetsHeading,
      goal_input: goal
    }]);

    // Non-blocking profile synthesis
    maybeUpdateResearcherProfile(user.id, newCount).catch(e =>
      console.error(`[${requestId}] Profile synthesis error:`, e.message)
    );

    console.log(`[${requestId}] Done – returning 200`);
    return res.status(200).json(finalJson);

  } catch (error) {
    console.error(`[${requestId}] ❌ UNHANDLED EXCEPTION:`, error);
    console.error(`[${requestId}] Stack:`, error.stack);
    return res.status(500).json({
      error: `Pipeline error: ${error.message.slice(0, 150)}`
    });
  }
}
