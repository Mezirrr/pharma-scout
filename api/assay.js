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
    // PHASE 1: Enhancer
    console.log(`[${requestId}] Phase 1: Enhancer`);
    let enhancedGoal = goal || 'General pharmacological profile';
    let optimizedQueries = {};

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
            { role: 'system', content: 'Return ONLY valid JSON: { "enhancedGoal": "technical reframing", "optimizedQueries": { "TargetName": "keyword string" } }' },
            { role: 'user', content: `Targets: ${targetsHeading}\nRaw Goal: ${goal || 'General info'}` }
          ]
        })
      }, 2, 6000);

      const enhData = await enhRes.json();
      const raw = enhData.choices[0].message.content;
      const parsed = extractJSON(raw);
      enhancedGoal = parsed.enhancedGoal || enhancedGoal;
      optimizedQueries = parsed.optimizedQueries || {};
    } catch (e) {
      console.warn(`[${requestId}] Enhancer fallback:`, e.message);
    }

    // PHASE 2: Semantic Scholar
    console.log(`[${requestId}] Phase 2: S2`);
    let allPapers = [];
    let fallbackTriggered = false;

    for (let i = 0; i < targetsArray.length; i++) {
      const target = targetsArray[i];
      if (i > 0) await new Promise(r => setTimeout(r, 1200));
      let query = optimizedQueries[target] || `${target} ${enhancedGoal}`;
      let url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=15&fields=paperId,title,url,year,abstract`;

      try {
        let s2Res = await fetchWithRetry(url, { headers: { 'x-api-key': s2ApiKey } }, 1, 6000);
        let s2Data = await s2Res.json();
        let papers = s2Data.data || [];
        if (papers.length === 0) {
          fallbackTriggered = true;
          await new Promise(r => setTimeout(r, 1200));
          url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(target)}&limit=15&fields=paperId,title,url,year,abstract`;
          s2Res = await fetchWithRetry(url, { headers: { 'x-api-key': s2ApiKey } }, 1, 6000);
          s2Data = await s2Res.json();
          papers = s2Data.data || [];
        }
        allPapers.push(...papers.map(p => ({
          title: p.title || 'Untitled',
          url: p.url || (p.paperId ? `https://www.semanticscholar.org/paper/${p.paperId}` : ''),
          year: p.year || 'Unknown',
          abstract: p.abstract?.substring(0, 400) + '...' || '',
          associatedTarget: target
        })).filter(p => p.url));
      } catch (err) {
        console.error(`[${requestId}] S2 error for ${target}:`, err.message);
      }
    }

    const seen = new Set();
    const uniquePapers = allPapers.filter(p => {
      if (!p.url || seen.has(p.url)) return false;
      seen.add(p.url);
      return true;
    }).slice(0, 35);

    // ================== PHASE 3: SYNTHESIS (DEEP CROSS-LINKING) ==================
    console.log(`[${requestId}] Phase 3: Synthesis`);
    const researcherContext = profile.researcher_profile
      ? `\n\nResearcher Focus Profile: ${profile.researcher_profile}`
      : '';

    const systemPrompt = `You are an elite 130‑IQ biomedical intelligence engine. Your analysis must be relentlessly deep, tracing every non‑obvious biochemical thread—including immune evasion, metabolic rewiring, epigenetic modulation, and feedback loops—whenever the source papers provide plausible mechanistic hints. Do not merely list resistance nodes; map the hidden crosstalk that could be exploited therapeutically.

For the "directResponse" (around 200 words, freely expand if needed), deliver a hyper‑analytical synthesis that:
- Explicitly connects the molecular cascades of the input targets (${targetsHeading}) with quantitative context (prevalence, binding affinities, clinical trial rates) only when the papers supply it.
- Uncovers emergent properties: e.g., MEK inhibition upregulating PD‑L1 via ERK–c‑Fos, leading to T‑cell exhaustion; EGFR blockade altering glycolytic flux and sensitizing to OXPHOS inhibitors; EMT‑driven feedback activating YAP/TAZ.
- Proposes novel combination hypotheses or a decision tree based on these non‑obvious connections.
- Avoids generic safety disclaimers and fluff. Be intellectually fearless and precise.

For "followUpOptions": exactly 3 strings (each ≤12 words) probing cascading enzymatic steps, structural affinities, or innovative therapeutic angles.

For "results": select the top relevant papers (max 15). For each:
- Write a relevance explanation ≤18 words linking findings directly to the target matrix.
- Classify "studyType" as "In Vitro", "In Vivo", or "Human".

Return ONLY valid JSON (no markdown fences) matching this schema:
{
  "directResponse": "string",
  "followUpOptions": ["string", "string", "string"],
  "results": [
    {
      "title": "paper title",
      "url": "paper url",
      "source": "Semantic Scholar",
      "year": "year",
      "relevance": "string (≤18 words)",
      "studyType": "In Vitro | In Vivo | Human"
    }
  ]
}

Now process:
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
