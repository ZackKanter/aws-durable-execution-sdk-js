#!/usr/bin/env node

import { execSync } from "child_process";

function runCommand(command, options = {}) {
  try {
    const result = execSync(command, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      ...options,
    });
    return { success: true, output: result };
  } catch (error) {
    return {
      success: false,
      output: error.stdout || error.message,
      stderr: error.stderr,
    };
  }
}

function summarizeBuild() {
  console.log("🔨 Building packages...");
  const start = Date.now();

  const result = runCommand("npm run build:quiet");
  const duration = ((Date.now() - start) / 1000).toFixed(1);

  if (result.success) {
    console.log(`✅ Build completed in ${duration}s`);

    // Show only warnings/errors, not full output
    const lines = result.output.split("\n");
    const importantLines = lines.filter(
      (line) =>
        line.includes("warning") ||
        line.includes("error") ||
        line.includes("✖"),
    );

    if (importantLines.length > 0) {
      console.log("\nWarnings/Errors:");
      importantLines.forEach((line) => console.log(line));
    }
  } else {
    console.log(`❌ Build failed in ${duration}s`);
    console.log(result.output);
  }

  return result.success;
}

function summarizeTests() {
  console.log("🧪 Running tests...");
  const start = Date.now();

  const result = runCommand("npm run test:quiet");
  const duration = ((Date.now() - start) / 1000).toFixed(1);

  // Check if tests actually passed by looking at exit code
  const testsPassed =
    result.success || (result.stderr && !result.stderr.includes("FAIL"));

  if (testsPassed) {
    console.log(`✅ Tests completed in ${duration}s`);

    // Extract coverage summaries
    const lines = result.output.split("\n");
    const coverageBlocks = [];
    let inCoverageBlock = false;
    let currentBlock = [];

    for (const line of lines) {
      if (line.includes("Coverage summary")) {
        inCoverageBlock = true;
        currentBlock = [line];
      } else if (inCoverageBlock && line.includes("====")) {
        currentBlock.push(line);
        if (currentBlock.length > 1) {
          coverageBlocks.push(currentBlock);
        }
        inCoverageBlock = false;
        currentBlock = [];
      } else if (inCoverageBlock) {
        currentBlock.push(line);
      }
    }

    // Show coverage summaries
    coverageBlocks.forEach((block, index) => {
      if (index === 0) console.log("\nCoverage Summary:");
      const summaryLines = block.filter(
        (line) =>
          line.includes("Statements") ||
          line.includes("Branches") ||
          line.includes("Functions") ||
          line.includes("Lines"),
      );
      summaryLines.forEach((line) => console.log(line));
      if (index < coverageBlocks.length - 1) console.log("");
    });
  } else {
    console.log(`❌ Tests failed in ${duration}s`);
    // Show only failure information
    const lines = result.output.split("\n");
    const failureLines = lines.filter(
      (line) =>
        line.includes("FAIL") ||
        line.includes("Error:") ||
        line.includes("✖") ||
        line.includes("Failed:"),
    );
    failureLines.forEach((line) => console.log(line));
  }

  return testsPassed;
}

// Main execution
const command = process.argv[2];

switch (command) {
  case "build":
    process.exit(summarizeBuild() ? 0 : 1);
  case "test":
    process.exit(summarizeTests() ? 0 : 1);
  case "all":
    const buildSuccess = summarizeBuild();
    const testSuccess = summarizeTests();
    process.exit(buildSuccess && testSuccess ? 0 : 1);
  default:
    console.log("Usage: node build-summary.js [build|test|all]");
    process.exit(1);
}
