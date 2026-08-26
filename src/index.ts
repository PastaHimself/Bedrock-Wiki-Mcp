#!/usr/bin/env node
import { runCli } from "./cli.js";

runCli()
  .then((exitCode) => {
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
