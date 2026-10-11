#!/usr/bin/env node
// The executable entry point. Everything it can do lives in cli.ts, so the tests drive the
// same path a user does rather than a parallel one built for them.

import { run } from "./cli.ts";

process.exitCode = await run(process.argv.slice(2));
