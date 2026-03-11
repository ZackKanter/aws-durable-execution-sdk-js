# Worker Module Execution for Durable Steps - Implementation Spec

## Overview

Add module-based worker execution capability to overcome function serialization limitations while providing robust isolation for CPU-intensive operations.

## Goals

- Execute step logic from separate module files in worker processes
- Eliminate function serialization constraints
- Support complex dependencies and imports
- Maintain existing context tracking and logging functionality
- Provide reliable alternative to function-based workers

## Motivation

Function serialization has inherent limitations:

- No external dependencies
- No closure variables
- Must import modules inside worker functions
- Complex setup for shared utilities

Module-based workers solve these by:

- Loading complete modules with all dependencies
- Supporting standard import/require patterns
- Enabling shared utility libraries
- Providing better developer experience

## Design

### API Changes

````typescript
export interface StepConfig<T> {
  // ... existing fields
  executionMode?: StepExecutionMode;

  /**
   * Path to worker module file (relative to project root).
   *
   * @remarks
   * When specified, the step executes the exported function from this module
   * in a worker process instead of the inline function. The module should
   * export a default function or named export matching the step name.
   *
   * @example
   * ```typescript
   * // Execute ./workers/image-processor.js in worker
   * await context.step("process-image", async () => {
   *   // This function is ignored when workerModule is specified
   * }, {
   *   executionMode: StepExecutionMode.WORKER,
   *   workerModule: './workers/image-processor.js'
   * });
   * ```
   */
  workerModule?: string;

  /**
   * Name of the exported function to execute (optional).
   *
   * @defaultValue 'default' or step name
   *
   * @remarks
   * Specifies which export from the worker module to execute.
   * Falls back to 'default' export or function matching step name.
   */
  workerExport?: string;
}
````

### Worker Module Interface

```typescript
/**
 * Standard interface for worker module functions.
 *
 * @param stepContext - Step execution context with logger
 * @param payload - Data passed from main process
 * @returns Promise resolving to step result
 */
export type WorkerModuleFunction<TInput = any, TOutput = any> = (
  stepContext: StepContext<Logger>,
  payload: TInput,
) => Promise<TOutput> | TOutput;
```

### Architecture

```
Main Process                    Worker Process
┌─────────────────┐            ┌─────────────────┐
│ runWithContext  │            │ require(module) │
│ ├─ stepHandler  │◄──────────►│ ├─ function     │
│ ├─ logger       │   payload  │ ├─ dependencies │
│ └─ checkpoint   │            │ └─ proxy logger │
└─────────────────┘            └─────────────────┘
```

## Implementation Tasks

### Task 1: Worker Module Infrastructure

**Files:** `src/handlers/step-handler/`

#### 1.1 Create Module Loader

- **File:** `step-worker-module-loader.ts`
- **Action:** Implement `loadWorkerModule()` function
- **Responsibilities:**
  - Resolve module path relative to project root
  - Load module and extract specified export
  - Validate function signature
  - Handle module loading errors

#### 1.2 Extend Worker Executor

- **File:** `step-worker-executor.ts`
- **Action:** Add module execution support
- **Responsibilities:**
  - Detect module vs function execution mode
  - Pass module path and export name to worker
  - Handle module-specific error messages

#### 1.3 Update Worker Script

- **File:** `step-worker.js`
- **Action:** Add module execution path
- **Responsibilities:**
  - Load specified module in worker context
  - Extract and execute specified export
  - Maintain same logging and error handling

### Task 2: Step Handler Integration

**File:** `src/handlers/step-handler/step-handler.ts`

#### 2.1 Modify executeStepLogic()

- **Action:** Add module execution branch
- **Code:**

```typescript
if (options?.executionMode === StepExecutionMode.WORKER) {
  if (options.workerModule) {
    // Module-based worker execution
    result = await runWithContext(
      stepId,
      parentId,
      () =>
        executeModuleInWorker(
          options.workerModule,
          options.workerExport,
          payload,
          logger,
        ),
      currentAttempt + 1,
      DurableExecutionMode.ExecutionMode,
    );
  } else {
    // Function-based worker execution (existing)
    result = await runWithContext(
      stepId,
      parentId,
      () => executeInWorker(fn, logger),
      currentAttempt + 1,
      DurableExecutionMode.ExecutionMode,
    );
  }
} else {
  // Inline execution (existing)
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

#### 3.1 Extend StepConfig Interface

- **Action:** Add `workerModule` and `workerExport` fields

#### 3.2 Add Worker Module Types

- **Action:** Define `WorkerModuleFunction` interface

### Task 4: Testing

**Files:** `src/handlers/step-handler/__tests__/`

#### 4.1 Unit Tests

- **File:** `step-handler-worker-module.test.ts`
- **Tests:**
  - Module loading and execution
  - Export resolution (default, named, step name)
  - Module not found errors
  - Invalid export errors
  - Complex dependency handling

#### 4.2 Integration Tests

- **File:** `step-handler-worker-module.integration.test.ts`
- **Tests:**
  - End-to-end module worker execution
  - Context tracking with modules
  - Logging from worker modules

### Task 5: Example Worker Modules

**Files:** `packages/aws-durable-execution-sdk-js-examples/src/workers/`

#### 5.1 Image Processing Worker

- **File:** `image-processor.js`
- **Demo:** Complex image processing with sharp dependency

#### 5.2 Data Processing Worker

- **File:** `data-transformer.js`
- **Demo:** CSV parsing and transformation with multiple utilities

#### 5.3 Crypto Worker

- **File:** `crypto-operations.js`
- **Demo:** Hashing and encryption operations

## Usage Examples

### Basic Module Worker

```typescript
// Main handler
export const handler = withDurableExecution(async (event, context) => {
  const result = await context.step(
    "process-image",
    async () => {
      // This function is ignored when workerModule is specified
      return null;
    },
    {
      executionMode: StepExecutionMode.WORKER,
      workerModule: "./workers/image-processor.js",
    },
  );

  return result;
});
```

```javascript
// ./workers/image-processor.js
const sharp = require("sharp");

module.exports = async function processImage(stepCtx, payload) {
  stepCtx.logger.info("Processing image in worker module");

  const { imageBuffer, width, height } = payload;

  return sharp(imageBuffer)
    .resize(width, height)
    .jpeg({ quality: 80 })
    .toBuffer();
};
```

### Named Export Worker

```typescript
// Use specific export from module
await context.step("hash-data", async () => null, {
  executionMode: StepExecutionMode.WORKER,
  workerModule: "./workers/crypto-operations.js",
  workerExport: "hashSHA256",
});
```

```javascript
// ./workers/crypto-operations.js
const crypto = require("crypto");

exports.hashSHA256 = async function (stepCtx, payload) {
  stepCtx.logger.info("Computing SHA256 hash");
  return crypto.createHash("sha256").update(payload.data).digest("hex");
};

exports.encrypt = async function (stepCtx, payload) {
  // Different crypto operation
};
```

### Complex Dependencies Worker

```typescript
// Worker with multiple dependencies and utilities
await context.step("transform-data", async () => null, {
  executionMode: StepExecutionMode.WORKER,
  workerModule: "./workers/data-transformer.js",
});
```

```javascript
// ./workers/data-transformer.js
const csv = require("csv-parser");
const { Transform } = require("stream");
const { validateEmail, formatPhone } = require("../utils/validators");

module.exports = async function transformData(stepCtx, payload) {
  stepCtx.logger.info("Transforming CSV data with validation");

  const results = [];

  // Complex processing with multiple dependencies
  for (const row of payload.csvData) {
    if (validateEmail(row.email)) {
      results.push({
        ...row,
        phone: formatPhone(row.phone),
        processed: true,
      });
    }
  }

  return results;
};
```

## Benefits Over Function Serialization

### ✅ Full Dependency Support

- Standard `require()` and `import` statements
- Complex dependency trees
- Shared utility libraries
- Third-party packages

### ✅ Better Developer Experience

- Familiar module patterns
- IDE support and intellisense
- Standard debugging workflows
- Easier testing of worker logic

### ✅ Code Organization

- Separate files for worker logic
- Reusable worker modules
- Clear separation of concerns
- Version control friendly

### ✅ Reliability

- No serialization edge cases
- Predictable module loading
- Standard Node.js behavior
- Better error messages

## Migration Path

Existing function-based workers continue to work:

```typescript
// Still supported - function serialization
await context.step(
  "simple-hash",
  async () => {
    const crypto = require("crypto");
    return crypto.createHash("sha256").update("data").digest("hex");
  },
  {
    executionMode: StepExecutionMode.WORKER,
  },
);

// New approach - module-based
await context.step("complex-processing", async () => null, {
  executionMode: StepExecutionMode.WORKER,
  workerModule: "./workers/processor.js",
});
```

## Success Criteria

- [ ] Worker modules load and execute successfully
- [ ] Complex dependencies work without issues
- [ ] Logging works seamlessly through proxy
- [ ] Context tracking preserved with `runWithContext`
- [ ] Error handling provides clear module-specific messages
- [ ] Performance comparable to function workers
- [ ] Zero breaking changes to existing API
- [ ] Function-based workers continue to work

## Implementation Phases

### Phase 1: Core Infrastructure

- [ ] Module loader implementation
- [ ] Worker script module support
- [ ] Basic execution path

### Phase 2: Integration & Testing

- [ ] Step handler integration
- [ ] Comprehensive test suite
- [ ] Error handling and edge cases

### Phase 3: Documentation & Examples

- [ ] Example worker modules
- [ ] Usage documentation
- [ ] Migration guide
