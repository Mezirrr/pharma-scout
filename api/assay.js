import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const TIER_LIMITS = {
  Free: 3,
  Starter: 50,
  Researcher: 200,
  'Lab Rat': 999999
};

const TIER_MAX_TOKENS = {
  Free: 5000,
  Starter: 7500,
  Researcher: 10000,
  'Lab Rat': 15000
};

const PROFILE_SYNTHESIS_EVERY = 5;

const S2_TIMEOUT_MS = 10000;
const S2_RETRIES = 2;
const S2_BASE_DELAY_MS = 1200;

async function fetchWithRetry(url, options = {}, retries = 2, timeoutMs = 8000) {
  for (let i = 0; i <= retries; i++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeoutId);
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const err = new Error('HTTP ' + response.status + ' – ' + body.slice(0, 200));
        err.status = response.status;
        throw err;
      }
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      if (i === retries) throw error;
      const isRateLimited = error.status === 429;
      const delay = isRateLimited ? 3000 * (i + 1) : 1000 * (i + 1);
      await new Promise(r => setTimeout(r, delay));
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
  if (!recent || !recent.length) return;

  const historyText = recent
    .map((s, i) => (i + 1) + '. Target(s): ' + s.target_searched + ' | Goal: ' + (s.goal_input || 'n/a'))
    .join('\n');

  const system = 'You write extremely terse researcher‑focus summaries. Given recent search queries, output ONLY a single plain‑text synthesis, ≤50 words. No preamble, no JSON.';

  try {
    const res = await fetchWithRetry('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.GROQ_API_KEY },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: historyText }
        ]
      })
    }, 1, 6000);
    const data = await res.json();
    const synth = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content ? data.choices[0].message.content.trim() : null;
    if (synth) {
      await supabaseAdmin.from('profiles').update({ researcher_profile: synth }).eq('id', userId);
    }
  } catch (e) {
    console.error('Profile synthesis failed (non-critical):', e.message);
  }
}

function repairJSON(str) {
  let cleaned = str.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  cleaned = cleaned.replace(/[\s\r\n]+$/g, '');
  
  const first = cleaned.indexOf('{'), last = cleaned.lastIndexOf('}');
  if (first === -1 || last === -1) throw new Error('No braces found');
  let json = cleaned.slice(first, last + 1);
  
  // Pre-parse fixes for common LLM mistakes:
  
  // 0. Strip markdown formatting from string values (Llama loves to add ** ** for bold)
  //    This removes **text** and __text__ and *text* patterns inside quoted strings
  //    Regex: find opening quote, then replace markdown decorators inside, then closing quote
  json = json.replace(/"([^"]*)"/g, (match) => {
    let inner = match.slice(1, -1); // Remove surrounding quotes
    // Remove markdown bold/italic/underline decorators
    inner = inner.replace(/\*\*(.+?)\*\*/g, '$1');  // **bold** → bold
    inner = inner.replace(/__(.+?)__/g, '$1');       // __bold__ → bold
    inner = inner.replace(/\*(.+?)\*/g, '$1');       // *italic* → italic
    inner = inner.replace(/_(.+?)_/g, '$1');         // _italic_ → italic
    return '"' + inner + '"';
  });
  
  // 1. Unquoted keys: `{key: value}` → `{"key": value}`
  //    This regex looks for: (opening brace or comma)(optional whitespace)(identifier)(optional whitespace)(colon)
  json = json.replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":');
  
  // 2. Trailing commas before ] or }
  json = json.replace(/,\s*([}\]])/g, '$1');
  
  // 3. Single-quoted strings to double-quoted (simple heuristic: preserve if nested quotes)
  json = json.replace(/'([^'\\]|\\.)*?'/g, (match) => {
    const inner = match.slice(1, -1);
    // Only convert if no double-quotes inside
    if (!inner.includes('"')) {
      return '"' + inner.replace(/\\'/g, "'") + '"';
    }
    return match;
  });

  try {
    return JSON.parse(json);
  } catch (e) {
    // Fallback: auto-close unclosed brackets
    const stack = [];
    for (let i = 0; i < json.length; i++) {
      if (json[i] === '[' || json[i] === '{') stack.push(json[i]);
      else if (json[i] === ']' || json[i] === '}') stack.pop();
    }
    let fixed = json;
    while (stack.length) {
      const opener = stack.pop();
      fixed += opener === '[' ? ']' : '}';
    }
    
    try {
      return JSON.parse(fixed);
    } catch (e2) {
      // Debug: show where the parse error is
      const posMatch = e.message.match(/position (\d+)/);
      const pos = posMatch ? parseInt(posMatch[1]) : 0;
      const context = json.slice(Math.max(0, pos - 80), Math.min(json.length, pos + 80));
      console.error('[JSON repair failed] Position ~' + pos + ', context: ' + context);
      throw e2;
    }
  }
}

function extractJSON(str) {
  return repairJSON(str);
}

function extractCompounds(text, excludeTerms = []) {
  if (!text) return [];
  const excludeLower = new Set(excludeTerms.map(t => t.toLowerCase()));
  const tokens = text.match(/\b(?=.*[a-zA-Z])(?=.*\d)[A-Za-z0-9\-]+\b/g) || [];
  return [...new Set(tokens)].filter(t => !excludeLower.has(t.toLowerCase()));
}

function trimRepeatedParagraph(text) {
  if (!text || text.length < 240) return text;
  const chunkLen = 120;
  for (let start = 0; start < text.length - chunkLen; start += 40) {
    const chunk = text.slice(start, start + chunkLen);
    const nextIdx = text.indexOf(chunk, start + chunkLen);
    if (nextIdx !== -1) {
      return text.slice(0, nextIdx).trim();
    }
  }
  return text;
}

// ========== PMC EUROPE PARALLEL SOURCE ==========
// PMC Europe (PubMed Central) is free, no key needed, fast, and complements S2 well.
// Their API: https://www.ebi.ac.uk/europepmc/webservices/rest/search
async function fetchPMCEuropePapers(query, limit = 10) {
  const url = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=' +
    encodeURIComponent(query) + '&format=json&pageSize=' + limit + '&cursorMark=*';
  
  try {
    const res = await fetchWithRetry(url, {}, 1, 8000);
    const data = await res.json();
    const results = data.resultList && data.resultList.result ? data.resultList.result : [];
    
    return results.map(r => ({
      title: r.title || 'Untitled',
      url: r.pmcid ? ('https://www.ncbi.nlm.nih.gov/pmc/articles/PMC' + r.pmcid) : 
           (r.doi ? ('https://doi.org/' + r.doi) : ''),
      year: r.pubYear || 'Unknown',
      abstract: (r.abstractText ? r.abstractText.substring(0, 400) + '...' : ''),
      source: 'PMC Europe'
    })).filter(p => p.url);
  } catch (e) {
    console.error('[PMC Europe error]:', e.message);
    return [];
  }
}

export default async function handler(req, res) {
  const rid = Math.random().toString(36).slice(2, 8);
  console.log('[' + rid + '] Incoming assay request');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Authentication required.' });
  const token = authHeader.replace('Bearer ', '');
  let user;
  try {
    const { data: { user: authUser }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !authUser) throw authError;
    user = authUser;
    console.log('[' + rid + '] Auth OK – ' + user.email);
  } catch (e) {
    console.error('[' + rid + '] Auth error:', e);
    return res.status(401).json({ error: 'Invalid session.' });
  }

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

    if (user.email === 'mezirrr@protonmail.com') {
      if (profile.tier !== 'Lab Rat') {
        console.log('[' + rid + '] Super user detected – upgrading to Lab Rat');
        await supabaseAdmin.from('profiles').update({
          tier: 'Lab Rat',
          assays_used_this_month: 0,
          usage_period: currentPeriod()
        }).eq('id', user.id);
        profile.tier = 'Lab Rat';
        profile.assays_used_this_month = 0;
        profile.usage_period = currentPeriod();
      }
    }

    console.log('[' + rid + '] Profile – tier: ' + profile.tier + ', used: ' + profile.assays_used_this_month);
  } catch (e) {
    console.error('[' + rid + '] Profile error:', e);
    return res.status(500).json({ error: 'Profile service error.' });
  }

  const period = currentPeriod();
  const used = profile.usage_period === period ? profile.assays_used_this_month : 0;
  const limit = TIER_LIMITS[profile.tier] || TIER_LIMITS.Free;
  if (used >= limit) {
    return res.status(403).json({
      error: 'Monthly limit reached (' + profile.tier + ': ' + limit + '). Please upgrade to continue.'
    });
  }

  const maxTokens = TIER_MAX_TOKENS[profile.tier] || 5000;

  const { target, goal, typeLabel } = req.body;
  if (!target) return res.status(400).json({ error: 'No target' });

  const targetsArray = target.split(',').map(t => t.trim()).filter(Boolean);
  if (!targetsArray.length) return res.status(400).json({ error: 'No valid targets' });

  const targetsHeading = targetsArray.join(', ');
  const s2ApiKey = process.env.S2_API_KEY;
  if (!s2ApiKey) {
    console.warn('[' + rid + '] No S2_API_KEY in env – using unauthenticated S2 (slower)');
  }
  const s2Headers = s2ApiKey ? { 'x-api-key': s2ApiKey } : {};

  const compoundsFromGoal = extractCompounds(goal, targetsArray);
  const compoundsFromTargets = extractCompounds(targetsHeading, targetsArray);
  const allCompounds = [...new Set([...compoundsFromGoal, ...compoundsFromTargets])];
  console.log('[' + rid + '] Detected compounds: ' + (allCompounds.join(', ') || 'none'));

  try {
    // ================== PHASE 1: ENHANCER ==================
    let enhancedGoal = goal || 'General pharmacological profile';
    let optimizedQueries = {};

    const enhSystem = 'You are a biomedical search strategist writing queries for a plain keyword-based academic search API (NOT a boolean/database query language). ' +
      'For each target, generate up to 5 short, natural-language search phrases (3-8 words each, no quotes, no AND/OR, no parentheses) that capture different facets of the goal — vary terminology, use synonyms, broader and narrower concepts. ' +
      'Write them the way you would type into Google Scholar. Return ONLY valid JSON: {"enhancedGoal":"technical reframing of the overall goal (1-2 sentences)", "optimizedQueries":{"TargetName":["query1","query2",...]}}}';

    try {
      const enhRes = await fetchWithRetry('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.GROQ_API_KEY },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: enhSystem },
            { role: 'user', content: 'Targets: ' + targetsHeading + '\nRaw Goal: ' + (goal || 'General info') }
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
          optimizedQueries[t] = q.filter(s => typeof s === 'string' && s.trim().length);
        } else if (typeof q === 'string' && q.trim()) {
          optimizedQueries[t] = [q];
        } else {
          optimizedQueries[t] = [];
        }
      }
    } catch (e) {
      console.warn('[' + rid + '] Enhancer fallback:', e.message);
      for (const t of targetsArray) {
        optimizedQueries[t] = [t + ' ' + (goal || '').trim()];
      }
    }

    for (const t of targetsArray) {
      if (!optimizedQueries[t]) optimizedQueries[t] = [];
      const rawGoalQuery = (t + ' ' + (goal || '')).trim();
      if (!optimizedQueries[t].includes(rawGoalQuery)) {
        optimizedQueries[t].push(rawGoalQuery);
      }
      for (const comp of allCompounds) {
        const compTargetQuery = comp + ' ' + t;
        if (!optimizedQueries[t].some(q => q.toLowerCase().includes(comp.toLowerCase()))) {
          optimizedQueries[t].unshift(compTargetQuery);
        }
      }
    }

    // ================== PHASE 2: PARALLEL SOURCES (S2 + PMC Europe) ==================
    let allPapers = [], fallbackTriggered = false;
    
    // Run S2 and PMC Europe in parallel for the first 1-2 queries per target
    for (const target of targetsArray) {
      const queries = optimizedQueries[target] || [target];
      let targetPapers = [];
      
      for (let qi = 0; qi < Math.min(queries.length, 3); qi++) {
        if (qi > 0) await new Promise(r => setTimeout(r, S2_BASE_DELAY_MS));
        const query = queries[qi];
        console.log('[' + rid + '] Query ' + (qi + 1) + '/' + queries.length + ' for "' + target + '": "' + query + '"');
        
        // Fetch from both sources in parallel
        const s2Promise = (async () => {
          try {
            const url = 'https://api.semanticscholar.org/graph/v1/paper/search?query=' + encodeURIComponent(query) + '&limit=10&fields=paperId,title,url,year,abstract';
            const s2Res = await fetchWithRetry(url, { headers: s2Headers }, S2_RETRIES, S2_TIMEOUT_MS);
            const s2Data = await s2Res.json();
            const papers = s2Data.data || [];
            console.log('[' + rid + '] S2 returned ' + papers.length + ' papers for "' + query + '"');
            return papers.map(p => ({
              title: p.title || 'Untitled',
              url: p.url || (p.paperId ? 'https://www.semanticscholar.org/paper/' + p.paperId : ''),
              year: p.year || 'Unknown',
              abstract: (p.abstract ? p.abstract.substring(0, 400) + '...' : ''),
              source: 'Semantic Scholar'
            })).filter(p => p.url);
          } catch (e) {
            console.warn('[' + rid + '] S2 error for "' + query + '":', e.message);
            return [];
          }
        })();
        
        const pmcPromise = fetchPMCEuropePapers(query, 10);
        
        const [s2Papers, pmcPapers] = await Promise.all([s2Promise, pmcPromise]);
        targetPapers.push(...s2Papers, ...pmcPapers);
        
        if (targetPapers.length >= 12) break;
      }
      
      if (targetPapers.length === 0) {
        fallbackTriggered = true;
      }
      allPapers.push(...targetPapers);
    }

    // Last-ditch fallback: both sources with combined query
    if (allPapers.length === 0) {
      console.log('[' + rid + '] Phase 2b: Last-ditch with raw goal');
      const lastQuery = (targetsHeading + ' ' + (goal || '')).trim();
      console.log('[' + rid + '] Last-ditch query: "' + lastQuery + '"');
      await new Promise(r => setTimeout(r, S2_BASE_DELAY_MS));
      
      const s2Promise = (async () => {
        try {
          const url = 'https://api.semanticscholar.org/graph/v1/paper/search?query=' + encodeURIComponent(lastQuery) + '&limit=10&fields=paperId,title,url,year,abstract';
          const s2Res = await fetchWithRetry(url, { headers: s2Headers }, S2_RETRIES, S2_TIMEOUT_MS);
          const s2Data = await s2Res.json();
          const papers = s2Data.data || [];
          console.log('[' + rid + '] Last-ditch S2 returned ' + papers.length + ' papers');
          return papers.map(p => ({
            title: p.title || 'Untitled',
            url: p.url || (p.paperId ? 'https://www.semanticscholar.org/paper/' + p.paperId : ''),
            year: p.year || 'Unknown',
            abstract: (p.abstract ? p.abstract.substring(0, 400) + '...' : ''),
            source: 'Semantic Scholar'
          })).filter(p => p.url);
        } catch (e) {
          console.warn('[' + rid + '] Last-ditch S2 failed:', e.message);
          return [];
        }
      })();
      
      const pmcLastditch = fetchPMCEuropePapers(lastQuery, 10);
      const [s2Papers, pmcPapers] = await Promise.all([s2Promise, pmcLastditch]);
      allPapers.push(...s2Papers, ...pmcPapers);
    }

    const seen = new Set();
    const uniquePapers = allPapers.filter(p => {
      if (!p.url || seen.has(p.url)) return false;
      seen.add(p.url);
      return true;
    }).slice(0, 35);

    console.log('[' + rid + '] Total unique papers: ' + uniquePapers.length);

    // ================== PHASE 3: SYNTHESIS ==================
    const researcherContext = profile.researcher_profile
      ? '\n\nKnown Researcher Focus Profile: ' + profile.researcher_profile
      : '';

    const systemPrompt = 'You are a 130-IQ elite biochemical intelligence engine specializing in cross-disciplinary synthesis, non-obvious mechanistic cross-linking, and exploratory hypothesis generation.\n\n' +
      'Your core mission: uncover unexpected molecular connections, off-target effects, and creative research directions — even if the supplied papers don\'t directly name the user\'s goal.\n\n' +
      'Your task:\n' +
      '1. Under "directResponse", provide a hyper-creative, mechanistically rigorous synthesis that connects the targets (' + targetsHeading + ') to the goal. **Open with the most scientifically bold or clinically surprising headline statement in bold, then elaborate with deep molecular detail.** Synthesize across disciplines: pathway biology, structural biology, medicinal chemistry, cell biology, phenotypic outcomes. Use your extensive knowledge to propose novel mechanisms and non-obvious cross-talk — the goal may be achievable through unexpected molecular angles. IMPORTANT: write each point exactly once — do not restate, repeat, or re-summarize any sentence or paragraph.\n' +
      '2. **Mention up to 3 relevant small molecules, drugs, or compounds (with names) and their known mechanisms.** These can be: (a) direct inhibitors/agonists of the target, (b) compounds that produce the desired phenotypic outcome via adjacent pathways, or (c) off-label/unexpected uses that illuminate the mechanism. Even if the papers don\'t mention them, use your knowledge.\n' +
      '3. Under "followUpOptions", give exactly 3 deep, insightful follow-up questions that would test or extend the hypothesis (≤12 words each). These should probe unexpected angles.\n' +
      '4. Under "results", include papers that illuminate the synthesis — not just directly-on-target work. Include: (a) papers on the target itself, (b) papers on pathway components, (c) papers on desired outcomes or phenotypes, (d) papers on unexpected off-target effects or cross-reactivity that might be mechanistically relevant. **If a paper sheds light on an adjacent mechanism, pathway interaction, or phenotypic pathway even if the title doesn\'t match perfectly, include it and explain how it\'s relevant.** If no papers are found, set "results" to an empty array []. For each paper you keep:\n' +
      '   - Write a ≤18-word relevance explanation: why does this paper illuminate the hypothesis?\n' +
      '   - Classify "studyType" as "In Vitro", "In Vivo", or "Human".\n\n' +
      'Return ONLY raw JSON matching:\n' +
      '{\n  "directResponse": "string",\n  "followUpOptions": ["string","string","string"],\n  "results": [\n    { "title":"string", "url":"string", "source":"string", "year":"string", "relevance":"string", "studyType":"In Vitro | In Vivo | Human" }\n  ],\n  "confidence": "high|low|none"\n}\n' +
      '- Set "confidence" to "high" if papers directly support or richly illuminate the synthesis.\n' +
      '- Set "confidence" to "low" if papers are sparse or tangential but still mechanistically relevant.\n' +
      '- Set "confidence" to "none" if no papers were found – synthesis is based on general knowledge, "results" is empty [].' +
      researcherContext;

    const userPrompt = 'Target type: ' + (typeLabel || 'unspecified') + '\n' +
      'All Inputs: ' + targetsHeading + '\n' +
      'Original Goal: ' + (goal || 'General info') + '\n' +
      'Enhanced Context: ' + enhancedGoal + '\n' +
      'Fallback active: ' + fallbackTriggered + '\n' +
      'Papers: ' + JSON.stringify(uniquePapers, null, 2) + '\n\n' +
      'Evaluate each paper for mechanistic relevance to the hypothesis. Include papers that illuminate adjacent pathways, unexpected mechanisms, phenotypic outcomes, or off-target effects — even if they don\'t directly mention the target or goal. Exclude only papers that are completely unrelated to the biology or chemistry at hand. The goal may be achievable through creative cross-linking, so be inclusive of tangential but mechanistically interesting work. Return the JSON.';

    const groqRes = await fetchWithRetry('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.GROQ_API_KEY },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: maxTokens,
        temperature: 0.6,
        frequency_penalty: 0.2,
        presence_penalty: 0.1
      })
    }, 2, 12000);

    const groqData = await groqRes.json();
    const rawText = groqData.choices[0].message.content;
    console.log('[' + rid + '] Groq raw (first 300):', rawText.slice(0, 300));

    let finalJson;
    try {
      finalJson = extractJSON(rawText);
    } catch (e) {
      console.error('[' + rid + '] JSON parse failed:', e.message);
      console.error('[' + rid + '] Raw text (first 500 chars):', rawText.slice(0, 500));
      return res.status(500).json({ error: 'AI returned unparseable format: ' + e.message.slice(0, 100) });
    }

    if (typeof finalJson.directResponse === 'string') {
      finalJson.directResponse = trimRepeatedParagraph(finalJson.directResponse);
    }

    if (!finalJson.confidence) {
      finalJson.confidence = finalJson.results && finalJson.results.length > 0 ? 'low' : 'none';
    }

    finalJson.isFallback = fallbackTriggered;

    // Usage update
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
    console.error('[' + rid + '] ❌ UNHANDLED:', error);
    return res.status(500).json({ error: 'Pipeline error: ' + error.message.slice(0, 150) });
  }
}
