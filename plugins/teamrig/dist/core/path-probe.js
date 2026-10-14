import { stat } from 'node:fs/promises';
/** The real filesystem, following links; anything it cannot stat counts as nothing. */
export const NODE_PATH_PROBE = {
    async kind(path) {
        try {
            const stats = await stat(path);
            return stats.isFile() ? 'file' : stats.isDirectory() ? 'folder' : 'none';
        }
        catch {
            return 'none';
        }
    },
};
