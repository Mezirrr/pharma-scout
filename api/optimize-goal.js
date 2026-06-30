export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { goal, targets } = req.body;
  if (!goal) return res.status(400).json({ error: 'No goal provided' });

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [
          {
            role: 'system',
            content: 'You are an expert at rewriting biomedical search queries for optimal literature retrieval. Given a raw goal and target(s), produce a single, concise, highly effective search goal string (max 20 words) that will find relevant scientific studies. Use technical synonyms and focus on mechanisms/pathways. Return ONLY the rewritten goal string, no JSON, no extra text.'
          },
          {
            role: 'user',
            content: `Targets: ${targets || 'unspecified'}\nRaw Goal: ${goal}`
          }
        ],
        max_tokens: 500,
        temperature: 0.4
      })
    });

    const data = await response.json();
    const optimizedGoal = data?.choices?.[0]?.message?.content?.trim() || goal;
    return res.status(200).json({ optimizedGoal });
  } catch (e) {
    console.error('Optimize goal error:', e);
    return res.status(200).json({ optimizedGoal: goal }); // fallback to original
  }
}
