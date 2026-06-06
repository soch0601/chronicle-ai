# Contributing to Chronicle AI

Thank you for your interest in contributing to Chronicle AI! Please follow these guidelines to get set up and submit changes.

## 🛠️ Development Setup

1. **Clone and Install Dependencies**:
   ```bash
   git clone https://github.com/your-org/chronicle-ai.git
   cd chronicle-ai/packages/core
   npm install
   ```

2. **Compiling the TypeScript Code**:
   Build the package to emit JS modules and type declarations into `/dist`:
   ```bash
   npm run build
   ```

## 🧪 Running Tests

Chronicle AI utilizes Jest to execute its test suite. Ensure all tests pass before making a pull request.

- **Unit Tests**:
  ```bash
  npm run test:unit
  ```
- **Integration Tests**:
  ```bash
  npm run test:integration
  ```

## 📊 Running the Example Sandbox

You can test local or remote model routing configurations in real time using the Auto-Summarizer example:
```bash
npx tsx examples/run.ts
```

## 🚀 Pull Request Guidelines

1. Fork the repository and create a descriptive branch name.
2. Commit your changes and ensure `npm run build` compiles without warnings.
3. Write matching unit or integration tests for your new features.
4. Open a PR describing the changes and the architectural impact.
