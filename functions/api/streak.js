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

    // Fetch all puzzle progress for this user
    const { results: puzzleRows } = await env.DB.prepare(
      `SELECT date, found_words, complete FROM puzzles WHERE token = ?`
    ).bind(token).all();

    // Build a map of { "2026-05-03": { found: ["WORD1", ...], complete: true } }
    const puzzles = {};
    for (const row of puzzleRows) {
      try {
        puzzles[row.date] = {
          found:    JSON.parse(row.found_words),
          complete: row.complete === 1,
        };
      } catch {
        puzzles[row.date] = { found: [], complete: false };
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

    // Always ensure the user row exists first (avoids FK issues on first visit)
    await env.DB.prepare(`
      INSERT INTO users (token, streak, last_completed)
      VALUES (?, 0, NULL)
      ON CONFLICT(token) DO NOTHING
    `).bind(token).run();

    // Update streak if provided
    if (streak !== undefined && lastCompleted !== undefined) {
      await env.DB.prepare(`
        UPDATE users SET streak = ?, last_completed = ? WHERE token = ?
      `).bind(streak, lastCompleted, token).run();
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
