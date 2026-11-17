#!/usr/bin/env node
// Entry point. Commands are added per workflow in src/commands/.
const [, , ...args] = process.argv;
if (args[0] === "--version") {
  console.log("0.0.0");
} else {
  console.log("aihub: under construction. Commands: pr, comments, cherry-pick, branch, story, pipeline, batch, work, init, skills, doctor.");
}
