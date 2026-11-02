#!/usr/bin/env node
// The executable entry point. Everything it can do lives in cli.ts, so the tests drive the
// same path a user does rather than a parallel one built for them.

import { run } from "./cli.ts";

// A reader that closes early (`tonedial show | head`) already has the output it wanted. The
// command still finishes, so a write it started is never cut short; only stdout goes quiet.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code !== "EPIPE") throw error;
});

process.exitCode = await run(process.argv.slice(2));
