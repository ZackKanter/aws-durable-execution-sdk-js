# Worker Process Execution for Durable Steps - Implementation Spec

## Overview

Add worker process execution capability to durable steps for isolation and resource control while maintaining existing context logging functionality.

## Goals

- Execute step functions in isolated worker processes
- Preserve existing `runWithContext` behavior for context tracking
- Maintain seamless logging through proxy logger
- Minimal API changes - simple opt-in via execution mode

## Limitations

### Function Serialization Constraints

Worker mode has important limitations due to function serialization:

**❌ External Dependencies Not Available**

```typescript
import { processImage } from "./utils";

// This will FAIL - processImage not available in worker
await context.step(
  "process",
  async () => {
    return processImage(data); // Error: processImage is not defined
  },
  { executionMode: StepExecutionMode.WORKER },
);
```

**❌ Closure Variables Not Accessible**

```typescript
const config = { quality: 80 };

// This will FAIL - config not available in worker
await context.step(
  "process",
  async () => {
    return compress(data, config); // Error: config is not defined
  },
  { executionMode: StepExecutionMode.WORKER },
);
```

**✅ Self-Contained Functions Work**

```typescript
// This WORKS - completely self-contained
await context.step(
  "hash",
  async () => {
    const crypto = require("crypto");
    return crypto.createHash("sha256").update("data").digest("hex");
  },
  { executionMode: StepExecutionMode.WORKER },
);

// This WORKS - import dependencies inside worker
await context.step(
  "process-image",
  async (stepCtx) => {
    const sharp = require("sharp");
    return sharp(buffer).resize(800, 600).toBuffer();
  },
  { executionMode: StepExecutionMode.WORKER },
);
```

### Requirements for Worker Functions

- **Self-contained**: No external function calls or imports outside the function
- **No closures**: Cannot access variables from outer scope
- **Import inside**: Use `require()` or `import()` within the worker function
- **JSON-serializable data**: All parameters must be serializable

## Design

### API Changes

````typescript
/**
 * Execution mode for step operations.
 *
 * @remarks
 * Controls where and how step functions are executed. Choose based on workload characteristics:
 *
 * - **INLINE**: Best for I/O operations (API calls, database queries, file operations)
 * - **WORKER**: Best for CPU-intensive tasks (image processing, hashing, data transformation)
 *
 * Worker mode provides process isolation but adds overhead (~10-50ms). Use for computationally
 * heavy operations that could benefit from isolation or when you need to protect the main
 * process from potential crashes in step logic.
 *
 * @example
 * ```typescript
 * // I/O operation - use default INLINE mode
 * await context.step("fetch-data", async () => {
 *   return fetchFromAPI(); // Network I/O
 * });
 *
 * // CPU-intensive - use WORKER mode
 * await context.step("process-image", async () => {
 *   return convertImageFormat(imageBuffer); // Heavy processing
 * }, {
 *   executionMode: StepExecutionMode.WORKER
 * });
 * ```
 *
 * @public
 */
export enum StepExecutionMode {
  /**
   * Execute step function in the main Lambda process (default).
   *
   * @remarks
   * Recommended for:
   * - API calls and network requests
   * - Database operations
   * - File system operations
   * - Quick computations
   *
   * Provides the best performance for I/O-bound operations with minimal overhead.
   */
  INLINE = "INLINE",

  /**
   * Execute step function in an isolated worker process.
   *
   * @remarks
   * Recommended for:
   * - Image/video processing
   * - Cryptographic operations (hashing, encryption)
   * - Large data transformations
   * - CPU-intensive computations
   * - Untrusted code execution
   *
   * Provides process isolation at the cost of additional overhead (~10-50ms).
   * Worker processes inherit system memory limits but run in isolation from the main process.
   */
  WORKER = "WORKER",
}

export interface StepConfig<T> {
  // ... existing fields
  /**
   * Execution mode for the step function.
   *
   * @defaultValue StepExecutionMode.INLINE
   *
   * @remarks
   * Determines whether the step executes in the main process (INLINE) or an isolated
   * worker process (WORKER). Choose WORKER for CPU-intensive operations that benefit
   * from isolation, and INLINE for I/O operations and quick computations.
   *
   * @example
   * ```typescript
   * // CPU-intensive operation
   * await context.step("hash-data", async () => {
   *   return computeExpensiveHash(largeDataset);
   * }, {
   *   executionMode: StepExecutionMode.WORKER
   * });
   * ```
   */
  executionMode?: StepExecutionMode;
}
````

### Architecture

```
Main Process                    Worker Process
┌─────────────────┐            ┌─────────────────┐
│ runWithContext  │            │                 │
│ ├─ stepHandler  │◄──────────►│ step function   │
│ ├─ logger       │   proxy    │ proxy logger    │
│ └─ checkpoint   │            │                 │
└─────────────────┘            └─────────────────┘
```

## Implementation Tasks

### Task 1: Core Infrastructure

**Files:** `src/handlers/step-handler/`

#### 1.1 Create Worker Logger Proxy

- **File:** `step-worker-logger.ts`
- **Action:** Create `WorkerLoggerProxy` class that forwards log calls via `postMessage`
- **Interface:** Same as `DurableLogger` but sends messages instead of logging directly

#### 1.2 Create Worker Executor

- **File:** `step-worker-executor.ts`
- **Action:** Implement `executeInWorker()` function
- **Responsibilities:**
  - Spawn worker with function code
  - Handle message passing (logs, results, errors)
  - Clean up worker on completion/error

#### 1.3 Create Worker Script

- **File:** `step-worker.js`
- **Action:** Worker thread entry point
- **Responsibilities:**
  - Reconstruct function from serialized code
  - Create proxy logger that sends messages to main
  - Execute function with `{ logger: proxyLogger }`
  - Send results/errors back to main

### Task 2: Step Handler Integration

**File:** `src/handlers/step-handler/step-handler.ts`

#### 2.1 Modify executeStepLogic()

- **Action:** Add conditional execution path for worker mode
- **Code:**

```typescript
if (options?.executionMode === StepExecutionMode.WORKER) {
  result = await runWithContext(
    stepId,
    parentId,
    () => executeInWorker(fn, logger),
    currentAttempt + 1,
    DurableExecutionMode.ExecutionMode,
  );
} else {
  const stepContext: StepContext<Logger> = { logger };
  result = await runWithContext(
    stepId,
    parentId,
    () => fn(stepContext),
    currentAttempt + 1,
    DurableExecutionMode.ExecutionMode,
  );
}
```

### Task 3: Type Definitions

**File:** `src/types/step.ts`

#### 3.1 Add Execution Mode Enum

- **Action:** Define `StepExecutionMode` enum

#### 3.2 Extend StepConfig Interface

- **Action:** Add `executionMode` field

### Task 4: Export Updates

**File:** `src/types/index.ts`

#### 4.1 Export New Types

- **Action:** Export `StepExecutionMode` for public API

### Task 5: Testing

**Files:** `src/handlers/step-handler/__tests__/`

#### 5.1 Unit Tests

- **File:** `step-handler-worker.test.ts`
- **Tests:**
  - Worker execution with successful result
  - Worker execution with error
  - Logger proxy functionality

#### 5.2 Integration Tests

- **File:** `step-handler-worker.integration.test.ts`
- **Tests:**
  - End-to-end worker execution
  - Context tracking preservation
  - Retry behavior with worker failures

### Task 6: Examples

**Files:** `packages/aws-durable-execution-sdk-js-examples/src/examples/`

#### 6.1 Basic Worker Example

- **File:** `step/worker-execution/`
- **Demo:** Simple step function running in worker process

## Action Items

### Phase 1: Core Implementation (Week 1)

- [ ] Implement `WorkerLoggerProxy` class
- [ ] Implement `executeInWorker()` function
- [ ] Create worker script (`step-worker.js`)
- [ ] Add type definitions
- [ ] Modify step handler execution logic

### Phase 2: Testing & Validation (Week 2)

- [ ] Write comprehensive unit tests
- [ ] Add integration tests
- [ ] Test error scenarios and edge cases
- [ ] Performance benchmarking

### Phase 3: Documentation & Examples (Week 3)

- [ ] Create example implementations
- [ ] Update API documentation
- [ ] Add troubleshooting guide
- [ ] Update AGENTS.md with worker execution patterns

## Success Criteria

- [ ] Step functions execute successfully in worker processes
- [ ] Logging works seamlessly through proxy
- [ ] Context tracking preserved with `runWithContext`
- [ ] Error handling and retries work as expected
- [ ] Zero breaking changes to existing API
- [ ] Performance overhead < 50ms for simple steps

## Risk Mitigation

- **Serialization Issues:** Validate function serialization/deserialization
- **Worker Overhead:** Benchmark performance impact
- **Lambda Compatibility:** Test in actual Lambda environment
- **Memory Leaks:** Ensure proper worker cleanup
- **Error Propagation:** Verify all error types are handled correctly

## Usage Example

```typescript
import {
  withDurableExecution,
  StepExecutionMode,
} from "@aws/durable-execution-sdk-js";

export const handler = withDurableExecution(async (event, context) => {
  // I/O operation - use INLINE (default) for API calls
  const data = await context.step("fetch-data", async () => {
    return fetchFromAPI(); // Network I/O - keep inline
  });

  // CPU-intensive operation - use WORKER for isolation
  // Note: Must be self-contained, import dependencies inside
  const processed = await context.step(
    "process-image",
    async (stepCtx) => {
      stepCtx.logger.info("Converting image format in worker");

      // Import required modules inside the worker function
      const sharp = require("sharp");

      // All processing logic must be self-contained
      return sharp(data.imageBuffer)
        .resize(800, 600)
        .jpeg({ quality: 80 })
        .toBuffer();
    },
    {
      executionMode: StepExecutionMode.WORKER,
    },
  );

  // I/O operation - use INLINE for database writes
  await context.step("save-result", async () => {
    return saveToDatabase(processed); // Database I/O - keep inline
  });

  return { result: processed };
});
```
