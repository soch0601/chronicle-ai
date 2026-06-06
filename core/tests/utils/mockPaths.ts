import { fileURLToPath } from 'url';
import path from 'path';

export const getMockPath = (metaUrl: string, mockFile: string) => {
    const dir = path.dirname(fileURLToPath(metaUrl));
    if (dir.endsWith('integration')) {
        return path.join(dir, '..', 'mocks', mockFile);
    }
    return path.join(dir, 'mocks', mockFile);
};
