import { runEval } from '../evals/evalRunner.js';
import fs from 'fs';
import path from 'path';

async function main() {
    const args = process.argv.slice(2);
    const schemaPathArg = args.find(a => a.startsWith('--schema='))?.split('=')[1];
    const tapeDirArg = args.find(a => a.startsWith('--tapeDir='))?.split('=')[1];
    const judgeArg = args.find(a => a.startsWith('--judge='))?.split('=')[1];

    if (!schemaPathArg || !tapeDirArg) {
        console.error("Usage: npm run eval -- --schema=<path> --tapeDir=<path> [--judge=<agent>]");
        process.exit(1);
    }

    const fullSchemaPath = path.isAbsolute(schemaPathArg) ? schemaPathArg : path.join(process.cwd(), schemaPathArg);
    const fullTapeDir = path.isAbsolute(tapeDirArg) ? tapeDirArg : path.join(process.cwd(), tapeDirArg);

    if (!fs.existsSync(fullSchemaPath)) {
        console.error(`Schema not found at: ${fullSchemaPath}`);
        process.exit(1);
    }

    const schema = JSON.parse(fs.readFileSync(fullSchemaPath, 'utf8'));

    console.log(`\n🚀 Starting Industrial Eval Runner`);
    console.log(`===================================`);
    console.log(`Workflow: ${schema.name} (v${schema.version})`);
    console.log(`Registry: ${fullTapeDir}`);
    if (judgeArg) console.log(`Judge:    ${judgeArg} (Semantic Fallback ENABLED)`);
    console.log(`===================================\n`);

    const storage = {
        read: async (threadId: string, stepCount: number) => {
            const file = path.join(fullTapeDir, threadId, `${stepCount}.json`);
            if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
            return null;
        },
        write: async (snapshot: any) => {},
        listThreads: async () => {
            if (!fs.existsSync(fullTapeDir)) return [];
            return fs.readdirSync(fullTapeDir).filter(f => fs.statSync(path.join(fullTapeDir, f)).isDirectory());
        },
        listSteps: async (threadId: string) => {
            const dir = path.join(fullTapeDir, threadId);
            if (!fs.existsSync(dir)) return [];
            return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => parseInt(f.replace('.json', '')));
        }
    };

    try {
        const results = await runEval(schema, storage, { judgeAgent: judgeArg });

        let passedCount = 0;
        let failedCount = 0;
        let totalTokens = 0;
        let totalCost = 0;

        results.forEach(res => {
            const status = res.passed ? '✅ PASS' : '❌ FAIL';
            const semanticInfo = res.semanticMatch ? ' (🤖 Semantic Match)' : '';
            const auditInfo = `[Tape: v${res.versionAudit.tapeVersion}]`;

            console.log(`${status}${semanticInfo} | ${res.threadId} | ${res.nodeName} ${auditInfo}`);

            if (res.usage) {
                totalTokens += res.usage.totalTokens || 0;
                totalCost += res.usage.estimatedCost || 0;
                console.log(`   └─ Usage: ${res.usage.totalTokens} tokens ($${(res.usage.estimatedCost || 0).toFixed(4)})`);
            }

            if (!res.passed) {
                if (res.reason) console.log(`   └─ Reason: ${res.reason}`);
                if (res.error) console.log(`   └─ Error: ${res.error}`);
                if (res.diff) {
                    console.log(`   └─ Diff: Expected '${res.diff.expected}', Got '${res.diff.actual}'`);
                }
                failedCount++;
            } else {
                passedCount++;
            }
        });

        console.log(`\n===================================`);
        console.log(`FINAL REPORT`);
        console.log(`===================================`);
        console.log(`Results:  ${passedCount} Passed, ${failedCount} Failed`);
        console.log(`Economy:  ${totalTokens.toLocaleString()} tokens used`);
        console.log(`Est Cost: $${totalCost.toFixed(4)}`);
        console.log(`===================================\n`);

        if (failedCount > 0) {
            process.exit(1);
        }
    } catch (err: any) {
        console.error(`Fatal Error: ${err.message}`);
        process.exit(1);
    }
}

main();
