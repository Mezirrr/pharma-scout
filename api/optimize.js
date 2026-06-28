// /api/optimize.js
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { prompt } = req.body;

  if (!prompt || prompt.trim() === '') {
    return res.status(400).json({ error: 'No prompt provided.' });
  }

  try {
    const systemPrompt = `You are an elite prompt engineering AI specializing in biochemical and pharmacological research.
The user will provide a raw, potentially messy research goal. 
Your task is to rewrite it into a highly technical, sharply focused scientific objective optimized for database querying and LLM comprehension.
- Elevate the terminology to standard academic nomenclature.
- Do not add conversational filler.
- Respond with ONLY the rewritten text string.`;

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
          { role: 'user', content: prompt }
        ],
        temperature: 0.2 
      })
    });

    const data = await groqRes.json();
    
    if (data.error) {
      throw new Error(data.error.message);
    }

    const optimized = data.choices[0].message.content.trim().replace(/^"|"$/g, '');

    res.status(200).json({ optimizedPrompt: optimized });
  } catch (error) {
    console.error("Optimization Error:", error);
    res.status(500).json({ error: "Failed to optimize prompt." });
  }
}
