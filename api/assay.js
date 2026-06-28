export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { target, goal, typeLabel } = req.body;

  try {
    // Split targets by comma, trim spaces, filter empty values
    const targetsArray = target.split(',').map(t => t.trim()).filter(Boolean);
    
    if (targetsArray.length === 0) {
      return res.status(400).json({ error: 'No valid targets provided.' });
    }

    let allRealPapers = [];
    let fallbackTriggered = false;

    // Phase 1 & 2: Process each target to fetch an expanded literature pool
    for (const singleTarget of targetsArray) {
      const queryExpansionPrompt = `You are an elite biochemical intelligence engine. The user has a research target and a lateral discovery goal.
Target: ${singleTarget}
Goal: ${goal}

Generate a clean, professional, unquoted PubMed/EuropePMC search query optimized to catch cross-disciplinary and mechanistic connections. 
- Do not include conversational filler.
- Use boolean operators (AND, OR) and clean keyword groupings.
- Focus on underlying pathways, target receptors, and physiological mechanisms.

Respond with ONLY the raw query string.`;

      const expansionRes = await fetch(`https://api.groq.com/openai/v1/chat/completions`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}` 
        },
        body: JSON.stringify({
          model: 'openai/gpt-oss-120b', 
          messages: [{ role: 'user', content: queryExpansionPrompt }]
        })
      });

      const expansionData = await expansionRes.json();
      let optimizedQuery = `${singleTarget} ${goal}`.trim();
      if (expansionData.choices && expansionData.choices.length > 0) {
        optimizedQuery = expansionData.choices[0].message.content.trim().replace(/^"|"$/g, '');
      }

      let pmcRes = await fetch(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(optimizedQuery)}&format=json&resultType=core&pageSize=20`);
      let pmcData = await pmcRes.json();

      // SMART FALLBACK per target
      if (!pmcData.resultList || !pmcData.resultList.result || pmcData.resultList.result.length === 0) {
        fallbackTriggered = true;
        const fallbackQuery = `${singleTarget}`.trim();
        pmcRes = await fetch(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(fallbackQuery)}&format=json&resultType=core&pageSize=20`);
        pmcData = await pmcRes.json();
      }

      if (pmcData.resultList && pmcData.resultList.result) {
        const mapped = pmcData.resultList.result.map(p => ({
          title: p.title,
          url: p.doi ? `https://doi.org/${p.doi}` : `https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/`,
          year: p.pubYear,
          abstract: p.abstractText ? p.abstractText.substring(0, 400) + '...' : 'No abstract available',
          associatedTarget: singleTarget // trace which paper belongs to which molecule
        }));
        allRealPapers.push(...mapped);
      }
    }

    // Deduplicate papers globally by URL just in case searches overlap
    const seenUrls = new Set();
    const uniquePapers = allRealPapers.filter(p => {
      if (seenUrls.has(p.url)) return false;
      seenUrls.add(p.url);
      return true;
    }).slice(0, 35); // Keep top 35 elements across all targets to filter down

    // Phase 3: Dynamic Multi-Target Synthesis
    const targetsHeading = targetsArray.join(', ');
    const systemPrompt = `You are an elite, highly open-minded scientific research assistant specializing in cross-disciplinary synthesis and non-obvious mechanistic cross-linking.

Your task is:
1. Under "directResponse", provide a deep, high-IQ direct response explaining the conceptual, structural, biochemical, or clinical connection between the user's multiple targets (${targetsHeading}) and their specific discovery goal.
   - Map out synergistic actions, shared pathways, or direct cell-signaling convergence points.
2. Under "followUpOptions", provide exactly 3 logical follow-up questions/goals (strings) based on the current analysis that a researcher might want to investigate next. Keep them under 12 words each.
3. Evaluate the combined list of papers and select the top relevant ones (up to a maximum of 15 total). 
   - Write a strict maximum 18-word "relevance" explanation for each, revealing how it links back to the target matrix and goal.
   - Accurately classify the "studyType" as exactly one of these strings: "In Vitro", "In Vivo", or "Human". If unknown, default to "In Vivo".

Respond with ONLY raw JSON matching exactly this schema:
{
  "directResponse": "string",
  "followUpOptions": ["string", "string", "string"],
  "results": [
    {
      "title": "string",
      "url": "string",
      "source": "PubMed",
      "year": "string",
      "relevance": "string",
      "studyType": "In Vitro | In Vivo | Human"
    }
  ]
}`;

    const userPrompt = `Target type: ${typeLabel || 'unspecified'}\nAll Inputs Requested: ${targetsHeading}\nGoal: ${goal || 'General info'}\nIs Fallback Broad Search Active: ${fallbackTriggered}\n\nHere are the real compiled papers found across targets:\n${JSON.stringify(uniquePapers, null, 2)}\n\nFilter and return the JSON.`;

    const groqRes = await fetch(`https://api.groq.com/openai/v1/chat/completions`, {
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
        ],
        response_format: { type: 'json_object' } 
      })
    });

    const groqData = await groqRes.json();
    const text = groqData.choices[0].message.content;
    
    const finalJson = JSON.parse(text);
    finalJson.isFallback = fallbackTriggered;

    res.status(200).json(finalJson);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}
