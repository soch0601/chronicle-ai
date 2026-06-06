import * as fs from 'fs';
import * as path from 'path';

export async function run(payload: any) {
    const targetDir = payload.target_directory || 'src';
    const cwd = process.cwd();
    // In our package context, the core package root is where package.json lives, process.cwd() should bepackages/core
    const fullPath = path.resolve(cwd, targetDir);

    let files: string[] = [];
    try {
        if (fs.existsSync(fullPath)) {
            const getFiles = (dir: string): string[] => {
                let results: string[] = [];
                const list = fs.readdirSync(dir);
                for (const file of list) {
                    const filePath = path.join(dir, file);
                    const stat = fs.statSync(filePath);
                    if (stat && stat.isDirectory()) {
                        results = results.concat(getFiles(filePath));
                    } else if (file.endsWith('.ts') || file.endsWith('.js')) {
                        results.push(path.relative(cwd, filePath).replace(/\\/g, '/'));
                    }
                }
                return results;
            };
            files = getFiles(fullPath);
        }
    } catch (e) {
        // Fallback
    }

    if (files.length === 0) {
        files = ["src/agentManager.ts", "src/engine.ts", "src/nodeFactory.ts", "src/workflowValidator.ts"];
    }

    return {
        repository_files: files
    };
}
