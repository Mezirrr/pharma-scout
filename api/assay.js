export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { target, goal, typeLabel } = req.body;

  try {
    // Phase 1: Expand query laterally
    const queryExpansionPrompt = `You are an elite biochemical intelligence engine. The user has a research target and a lateral discovery goal.
Target: ${target}
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
    let optimizedQuery = `${target} ${goal}`.trim();
    if (expansionData.choices && expansionData.choices.length > 0) {
      optimizedQuery = expansionData.choices[0].message.content.trim().replace(/^"|"$/g, '');
    }

    // Phase 2: Fetch an expanded set of 30 papers
    let pmcRes = await fetch(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(optimizedQuery)}&format=json&resultType=core&pageSize=30`);
    let pmcData = await pmcRes.json();
    let isFallback = false;

    // SMART FALLBACK: If zero results, search just the target generally to gather partially related studies
    if (!pmcData.resultList || !pmcData.resultList.result || pmcData.resultList.result.length === 0) {
      isFallback = true;
      const fallbackQuery = `${target}`.trim();
      pmcRes = await fetch(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(fallbackQuery)}&format=json&resultType=core&pageSize=30`);
      pmcData = await pmcRes.json();
    }

    let realPapers = [];
    if (pmcData.resultList && pmcData.resultList.result) {
      realPapers = pmcData.resultList.result.map(p => ({
        title: p.title,
        url: p.doi ? `https://doi.org/${p.doi}` : `https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/`,
        year: p.pubYear,
        abstract: p.abstractText ? p.abstractText.substring(0, 400) + '...' : 'No abstract available'
      }));
    }

    // Phase 3: Run the synthesis and pull up to 15 papers
    const systemPrompt = `You are an elite, highly open-minded scientific research assistant specializing in cross-disciplinary synthesis and non-obvious mechanistic cross-linking.

Your task is twofold:
1. Under "directResponse", provide a deep, high-IQ direct response explaining the conceptual, structural, biochemical, or clinical connection between the user's target and their goal.
   - Do not rely solely on surface-level or indirect physiological properties (such as changes in physical loading or muscle mass). You must cleanly map out direct cell-signaling pathways (e.g., direct ligand-receptor actions on osteoblasts/osteoclasts).
   - Trace cross-talk between related ligands/pathways comprehensively. If a target receptor is blocked, identify ALL major competing ligands (e.g., Myostatin, Activins, and GDFs) and explain downstream shifts in alternative pathways (e.g., BMP/TGF-beta balancing).
   - Detail the explicit molecular mechanisms behind any side effects or safety risks mentioned (e.g., mechanistic drivers of heterotopic/ectopic ossification or pathway runaways).
2. Evaluate the provided list of papers and select the top relevant ones (up to a maximum of 15). 
   - Write a strict maximum 18-word "relevance" explanation for each, revealing how it links or provides foundational/partial context back to the target and goal.
   - Analyze the title and abstract text to accurately classify the "studyType" as exactly one of these strings: "In Vitro", "In Vivo", or "Human". If it cannot be determined, default to "In Vivo".

Respond with ONLY raw JSON matching exactly this schema:
{
  "directResponse": "string",
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

    const userPrompt = `Target type: ${typeLabel || 'unspecified'}\nTarget: ${target}\nGoal: ${goal || 'General info'}\nIs Fallback Broad Search: ${isFallback}\n\nHere are the real papers found:\n${JSON.stringify(realPapers, null, 2)}\n\nFilter and return the JSON.`;

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
    finalJson.isFallback = isFallback;

    res.status(200).json(finalJson);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}
