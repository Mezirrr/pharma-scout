import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const TIER_LIMITS = { Free: 10, Mini: 250, Max: 750 };
const PROFILE_SYNTHESIS_EVERY = 5;

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

function extractJSON(str) {
  let cleaned = str.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1) throw new Error('No JSON braces found');
  return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
}

export default async function handler(req, res) {
  const requestId = Math.random().toString(36).slice(2, 8);
  console.log(`[${requestId}] Incoming assay request`);

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Authentication required.' });

  const token = authHeader.replace('Bearer ', '');
  let user;
  try {
    const { data: { user: authUser }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !authUser) throw authError;
    user = authUser;
    console.log(`[${requestId}] Auth OK – ${user.email}`);
  } catch (e) {
    console.error(`[${requestId}] Auth error:`, e);
    return res.status(401).json({ error: 'Invalid session.' });
  }

  // Profile lookup / auto-create
  let profile;
  try {
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    if (error && error.code === 'PGRST116') {
      await supabaseAdmin.from('profiles').insert({
        id: user.id,
        email: user.email,
        tier: 'Free',
        assays_used_this_month: 0,
        usage_period: currentPeriod(),
        search_count: 0
      });
      const { data: newProfile } = await supabaseAdmin
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .single();
      profile = newProfile;
    } else if (error || !data) {
      throw error || new Error('Profile not found');
    } else {
      profile = data;
    }
    console.log(`[${requestId}] Profile – tier: ${profile.tier}, used: ${profile.assays_used_this_month}`);
  } catch (e) {
    console.error(`[${requestId}] Profile error:`, e);
    return res.status(500).json({ error: 'Profile service error.' });
  }

  const isSuperUser = (user.email === 'mezirrr@protonmail.com');
  if (isSuperUser) console.log(`[${requestId}] Super user – no limits.`);

  if (!isSuperUser) {
    const period = currentPeriod();
    const used = profile.usage_period === period ? (profile.assays_used_this_month || 0) : 0;
    const limit = TIER_LIMITS[profile.tier] || TIER_LIMITS.Free;
    console.log(`[${requestId}] Usage: ${used}/${limit}`);
    if (used >= limit) {
      return res.status(403).json({
        error: `Monthly limit reached (${profile.tier}: ${limit}). Upgrade to continue.`
      });
    }
  }

  const { target, goal, typeLabel } = req.body;
  if (!target) return res.status(400).json({ error: 'No target provided.' });

  const targetsArray = target.split(',').map(t => t.trim()).filter(Boolean);
  if (!targetsArray.length) return res.status(400).json({ error: 'No valid targets.' });

  const targetsHeading = targetsArray.join(', ');
  const s2ApiKey = "s2k-zRgzPNUsqrylk6ST4j78YbPFDcq74woh6HR4Uawp";

  try {
    // ================== PHASE 1: ENHANCER (multi-query) ==================
    console.log(`[${requestId}] Phase 1: Enhancer (multi-query)`);
    let enhancedGoal = goal || 'General pharmacological profile';
    let optimizedQueries = {};

    const enhancerSystem = `You are a biomedical search strategist. For each target, generate up to 3 complementary, high-yield search strings that capture different facets of the user's goal (e.g., mechanisms, case reports, related pathways). Use synonyms and broader/narrower terms to maximise recall.

Return ONLY valid JSON:
{
  "enhancedGoal": "technical reframing of the overall goal (1-2 sentences)",
  "optimizedQueries": {
    "TargetName": ["query string 1", "query string 2", ...]
  }
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
      const raw = enhData.choices[0].message.content;
      const parsed = extractJSON(raw);
      enhancedGoal = parsed.enhancedGoal || enhancedGoal;
      const rawQueries = parsed.optimizedQueries || {};
      for (const [t, q] of Object.entries(rawQueries)) {
        if (Array.isArray(q)) {
          optimizedQueries[t] = q.filter(s => typeof s === 'string' && s.trim().length > 0);
        } else if (typeof q === 'string' && q.trim().length > 0) {
          optimizedQueries[t] = [q];
        } else {
          optimizedQueries[t] = [];
        }
      }
    } catch (e) {
      console.warn(`[${requestId}] Enhancer fallback:`, e.message);
      for (const t of targetsArray) {
        optimizedQueries[t] = [`${t} ${goal || ''}`.trim()];
      }
    }

    for (const t of targetsArray) {
      if (!optimizedQueries[t] || optimizedQueries[t].length === 0) {
        optimizedQueries[t] = [`${t} ${goal || ''}`.trim()];
      }
      if (!optimizedQueries[t].includes(t)) {
        optimizedQueries[t].push(t);
      }
    }

    // ================== PHASE 2: SEMANTIC SCHOLAR ==================
    console.log(`[${requestId}] Phase 2: S2 (multi-query)`);
    let allPapers = [];
    let fallbackTriggered = false;

    for (const target of targetsArray) {
      const queries = optimizedQueries[target] || [target];
      let targetPapers = [];

      for (let qi = 0; qi < queries.length; qi++) {
        if (qi > 0) await new Promise(r => setTimeout(r, 1200));
        const query = queries[qi];
        console.log(`[${requestId}] S2 query ${qi + 1}/${queries.length} for "${target}": "${query}"`);
        const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=10&fields=paperId,title,url,year,abstract`;

        try {
          const s2Res = await fetchWithRetry(url, { headers: { 'x-api-key': s2ApiKey } }, 1, 6000);
          const s2Data = await s2Res.json();
          const papers = s2Data.data || [];
          if (papers.length > 0) {
            const mapped = papers.map(p => ({
              title: p.title || 'Untitled',
              url: p.url || (p.paperId ? `https://www.semanticscholar.org/paper/${p.paperId}` : ''),
              year: p.year || 'Unknown',
              abstract: p.abstract?.substring(0, 400) + '...' || '',
              associatedTarget: target
            })).filter(p => p.url);
            targetPapers.push(...mapped);
          }
          if (targetPapers.length >= 8) break;
        } catch (err) {
          console.error(`[${requestId}] S2 error for query "${query}":`, err.message);
        }
      }

      if (targetPapers.length === 0) {
        fallbackTriggered = true;
        console.log(`[${requestId}] All queries failed for "${target}", marking fallback.`);
      }

      allPapers.push(...targetPapers);
    }

    const seen = new Set();
    const uniquePapers = allPapers.filter(p => {
      if (!p.url || seen.has(p.url)) return false;
      seen.add(p.url);
      return true;
    }).slice(0, 35);

    console.log(`[${requestId}] Total unique papers: ${uniquePapers.length}`);

    // ================== PHASE 3: SYNTHESIS (old prompt style + primary anchor) ==================
    console.log(`[${requestId}] Phase 3: Synthesis`);
    const researcherContext = profile.researcher_profile
      ? `\n\nKnown Researcher Focus Profile (derived from this user's last several searches — use it to silently tailor the depth/angle of your analysis and follow-up questions toward their underlying motive, but do not restate it verbatim): ${profile.researcher_profile}`
      : '';

    const systemPrompt = `You are a 130-IQ, elite biochemical intelligence architecture specializing in cross-disciplinary synthesis and non-obvious mechanistic cross-linking.

Your task:
1. Under "directResponse", provide a hyper-analytical, flawlessly logical 130-IQ synthesis explaining the conceptual, structural, biochemical, or clinical connection between the user's targets (${targetsHeading}) and their discovery goal.
   - **Start by identifying and explicitly detailing the primary, canonical molecular mechanism(s)** that most directly explain the observed effect (e.g., FGFR inhibition → STAT1/p21 suppression → chondrocyte proliferation). Use quantitative context if papers provide it.
   - Then, freely map out explicit synergistic actions, shared metabolic pathways, or direct ligand-receptor convergence points that emerge from this primary axis. Explore feedback loops, hidden crosstalk, and emergent pharmacological properties.
   - Strike an authoritative, deeply academic, and highly technical tone. Avoid fluff, unnecessary introductory pleasantries, and thesaurus-bloat.
2. Under "followUpOptions", provide exactly 3 deeply analytical, highly insightful follow-up questions (strings) investigating cascading enzymatic steps or structural affinities. Max 12 words each.
3. Select the top relevant papers (up to 15).
   - Write a strict max 18-word "relevance" explanation for each, explicitly linking its findings to the target matrix.
   - Classify "studyType" strictly as: "In Vitro", "In Vivo", or "Human". Default to "In Vivo" if ambiguous.

Respond with ONLY raw JSON matching exactly this schema:
{
  "directResponse": "string",
  "followUpOptions": ["string", "string", "string"],
  "results": [
    {
      "title": "string",
      "url": "string",
      "source": "Semantic Scholar",
      "year": "string",
      "relevance": "string",
      "studyType": "In Vitro | In Vivo | Human"
    }
  ]
}${researcherContext}`;

    const userPrompt = `Target type: ${typeLabel || 'unspecified'}
All Inputs Requested: ${targetsHeading}
Original Goal: ${goal || 'General info'}
Enhanced Analytical Context: ${enhancedGoal}
Is Fallback Broad Search Active: ${fallbackTriggered}

Here are the real compiled papers found across targets:
${JSON.stringify(uniquePapers, null, 2)}

Filter and return the JSON.`;

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
          { role: 'user', content: userPrompt }
        ]
        // No response_format — we parse JSON manually
      })
    }, 2, 12000);

    const groqData = await groqRes.json();
    const rawText = groqData.choices[0].message.content;
    console.log(`[${requestId}] Groq raw (first 300):`, rawText.slice(0, 300));

    let finalJson;
    try {
      finalJson = extractJSON(rawText);
    } catch (e) {
      console.error(`[${requestId}] JSON parse failed:`, e.message);
      console.error(`[${requestId}] Full:`, rawText);
      return res.status(500).json({ error: 'AI returned invalid format.' });
    }

    finalJson.isFallback = fallbackTriggered;
    if (finalJson.results) finalJson.results.forEach(r => r.source = 'Semantic Scholar');

    // Usage update
    const period = currentPeriod();
    const usedNow = (profile.usage_period === period ? profile.assays_used_this_month : 0) + 1;
    const newCount = (profile.search_count || 0) + 1;

    await supabaseAdmin.from('profiles').update({
      assays_used_this_month: usedNow,
      usage_period: period,
      search_count: newCount
    }).eq('id', user.id);

    await supabaseAdmin.from('search_history').insert([{
      user_id: user.id,
      target_searched: targetsHeading,
      goal_input: goal
    }]);

    maybeUpdateResearcherProfile(user.id, newCount);

    return res.status(200).json(finalJson);
  } catch (error) {
    console.error(`[${requestId}] ❌ UNHANDLED:`, error);
    return res.status(500).json({ error: `Pipeline error: ${error.message.slice(0, 150)}` });
  }
}
