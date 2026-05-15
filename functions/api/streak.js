export async function onRequest(context) {
  const { request, env } = context;

  // ── GET /api/streak?token=xxx ─────────────────────────────────────────────
  // Returns streak info + list of completed puzzle dates for this token.
  if (request.method === "GET") {
    const url   = new URL(request.url);
    const token = url.searchParams.get("token");

    if (!token) {
      return Response.json({ success: false, error: "Missing token" }, { status: 400 });
    }

    const user = await env.DB.prepare(
      `SELECT streak, last_completed FROM users WHERE token = ?`
    ).bind(token).first();

    // Fetch all completed puzzle dates for this user
    const { results: puzzleRows } = await env.DB.prepare(
      `SELECT date, found_words FROM puzzles WHERE token = ?`
    ).bind(token).all();

    // Build a map of { "2026-05-03": ["WORD1", ...], ... }
    const puzzles = {};
    for (const row of puzzleRows) {
      try {
        puzzles[row.date] = JSON.parse(row.found_words);
      } catch {
        puzzles[row.date] = [];
      }
    }

    return Response.json({
      success:       true,
      streak:        user?.streak        || 0,
      lastCompleted: user?.last_completed || null,
      puzzles,
    });
  }

  // ── POST /api/streak ──────────────────────────────────────────────────────
  // Body: { token, streak, lastCompleted, date, foundWords, complete }
  //   streak/lastCompleted — update user streak row
  //   date/foundWords/complete — upsert a puzzle progress row
  // Any combination can be sent; fields present will be written.
  if (request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ success: false, error: "Invalid JSON" }, { status: 400 });
    }

    const { token, streak, lastCompleted, date, foundWords, complete } = body;

    if (!token) {
      return Response.json({ success: false, error: "Missing token" }, { status: 400 });
    }

    // Update streak if provided
    if (streak !== undefined && lastCompleted !== undefined) {
      await env.DB.prepare(`
        INSERT INTO users (token, streak, last_completed)
        VALUES (?, ?, ?)
        ON CONFLICT(token) DO UPDATE SET
          streak         = excluded.streak,
          last_completed = excluded.last_completed
      `).bind(token, streak, lastCompleted).run();
    }

    // Upsert puzzle progress if provided
    if (date !== undefined && foundWords !== undefined) {
      await env.DB.prepare(`
        INSERT INTO puzzles (token, date, found_words, complete)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(token, date) DO UPDATE SET
          found_words = excluded.found_words,
          complete    = excluded.complete
      `).bind(token, date, JSON.stringify(foundWords), complete ? 1 : 0).run();
    }

    return Response.json({ success: true });
  }

  return new Response("Method not allowed", { status: 405 });
}
