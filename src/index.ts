#!/usr/bin/env node

import { runServer } from "./runtime.js";

runServer({ argv: process.argv, env: process.env }).catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
