import fs from "fs/promises";
import path from "path";

let isWasmerInitialized = false;
let cachedBashPkg: any = null;

async function ensureWasmer(): Promise<any> {
    if (!isWasmerInitialized) {
        const sdk = await import("@wasmer/sdk");
        await sdk.init();
        isWasmerInitialized = true;
    }
    return import("@wasmer/sdk");
}

export async function warmupWasm(): Promise<void> {
    const { Wasmer } = await ensureWasmer();
    if (!cachedBashPkg) {
        cachedBashPkg = await Wasmer.fromRegistry("sharrattj/bash");
    }
}

export function resetWasmCache(): void {
    isWasmerInitialized = false;
    cachedBashPkg = null;
}

async function writeToVirtualDir(dir: any, relativePath: string, content: Buffer | string) {
    const normalized = relativePath.replace(/\\/g, "/");
    const parts = normalized.split("/");
    let currentPath = "";
    for (let i = 0; i < parts.length - 1; i++) {
        if (!parts[i]) continue;
        currentPath = currentPath ? currentPath + "/" + parts[i] : parts[i];
        try {
            await dir.createDir(currentPath);
        } catch (e) {
            // Directory might already exist
        }
    }
    const filePath = normalized.startsWith("/") ? normalized : "/" + normalized;
    await dir.writeFile(filePath, content);
}

async function readStreamAndTrace(
    stream: any,
    onChunk: (text: string) => void
): Promise<string> {
    if (!stream) return "";
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            fullText += text;
            onChunk(text);
        }
        const remaining = decoder.decode();
        if (remaining) {
            fullText += remaining;
            onChunk(remaining);
        }
    } finally {
        reader.releaseLock();
    }
    return fullText;
}

export async function executeSandboxedBash(
    command: string,
    sandboxFiles: string[] | undefined,
    sandboxEnv: string[] | undefined,
    cwd: string,
    trace: any,
    signal: AbortSignal
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const { Wasmer, Directory } = await ensureWasmer();
    
    if (signal?.aborted) {
        throw new Error("Action timed out or aborted.");
    }

    const virtualDir = new Directory();

    if (sandboxFiles && sandboxFiles.length > 0) {
        for (const file of sandboxFiles) {
            const hostPath = path.isAbsolute(file) ? file : path.resolve(cwd, file);
            let content: Buffer;
            try {
                content = await fs.readFile(hostPath);
            } catch (err: any) {
                throw new Error(`Failed to read sandbox file ${file}: ${err.message}`);
            }
            await writeToVirtualDir(virtualDir, file, content);
        }
    }

    const envVars: Record<string, string> = {};
    if (sandboxEnv && sandboxEnv.length > 0) {
        for (const envKey of sandboxEnv) {
            if (process.env[envKey] !== undefined) {
                envVars[envKey] = process.env[envKey]!;
            }
        }
    }

    const pkg = cachedBashPkg || await Wasmer.fromRegistry("sharrattj/bash");

    if (signal?.aborted) {
        throw new Error("Action timed out or aborted.");
    }

    const instance = await pkg.entrypoint.run({
        args: ["-c", command],
        mount: {
            "/": virtualDir
        },
        env: envVars
    });

    const onAbort = () => {
        try {
            // Wasmer instances do not have a kill() method on instance, but wait will reject/abort
        } catch (e) {}
    };
    if (signal) {
        signal.addEventListener("abort", onAbort);
    }

    // Read streams concurrently
    const stdoutPromise = readStreamAndTrace(instance.stdout, (chunk) => {
        trace("ACTION_STREAM", chunk, { stream: "stdout" });
    });
    const stderrPromise = readStreamAndTrace(instance.stderr, (chunk) => {
        trace("ACTION_STREAM", chunk, { stream: "stderr" });
    });

    try {
        const [{ code }, stdout, stderr] = await Promise.all([
            instance.wait(),
            stdoutPromise,
            stderrPromise
        ]);

        if (signal) {
            signal.removeEventListener("abort", onAbort);
        }

        if (code === 0) {
            return { stdout, stderr, exitCode: code };
        } else {
            const bashError = new Error(`Command failed with exit code ${code}`);
            (bashError as any).stdout = stdout;
            (bashError as any).stderr = stderr;
            (bashError as any).exitCode = code;
            throw bashError;
        }
    } catch (err: any) {
        if (signal) {
            signal.removeEventListener("abort", onAbort);
        }
        if (signal?.aborted || err.name === "AbortError") {
            throw new Error("Action timed out or aborted.");
        }
        throw err;
    }
}
