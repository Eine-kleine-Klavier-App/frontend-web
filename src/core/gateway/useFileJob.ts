import { useCallback, useEffect, useRef, useState } from 'react';
import { libraryGateway } from '@/core/gateway/defaultLibraryGateway';
import type { ImportJob, ImportState } from '@/core/gateway/LibraryGateway';
import { errorMessage } from '@/core/errorMessage';

const POLL_MS = 700;
const GIVE_UP_MS = 5 * 60_000;

export type FileJobStatus =
  | { phase: 'idle' }
  | { phase: 'running'; fileName: string; state: ImportState }
  | { phase: 'done'; fileName: string; job: ImportJob }
  | { phase: 'failed'; fileName: string; message: string };

/** Sends a file to the backend and follows the job it starts until it ends. A new run, or leaving
 *  the screen, drops the one before it: only the latest run reports. Used by the import in Library
 *  and by the comparison in the editor. */
export function useFileJob(): {
  status: FileJobStatus;
  run: (file: File, start: (file: File) => Promise<ImportJob>) => Promise<ImportJob | null>;
  clear: () => void;
} {
  const [status, setStatus] = useState<FileJobStatus>({ phase: 'idle' });
  const latest = useRef(0);
  useEffect(() => () => { latest.current += 1; }, []);

  const run = useCallback(async (file: File, start: (file: File) => Promise<ImportJob>) => {
    const mine = ++latest.current;
    const current = () => latest.current === mine;
    setStatus({ phase: 'running', fileName: file.name, state: 'queued' });
    try {
      let job = await start(file);
      const giveUp = Date.now() + GIVE_UP_MS;
      while (job.state !== 'done' && job.state !== 'failed') {
        if (!current()) return null;
        setStatus({ phase: 'running', fileName: file.name, state: job.state });
        await new Promise((resolve) => window.setTimeout(resolve, POLL_MS));
        if (!current()) return null;
        if (Date.now() > giveUp) throw new Error('This is taking too long. Try again in a moment.');
        job = await libraryGateway.getImportJob(job.jobId);
      }
      if (!current()) return null;
      if (job.state === 'failed') {
        setStatus({ phase: 'failed', fileName: file.name, message: job.error ?? 'The file could not be read.' });
        return null;
      }
      setStatus({ phase: 'done', fileName: file.name, job });
      return job;
    } catch (cause) {
      if (current()) setStatus({ phase: 'failed', fileName: file.name, message: errorMessage(cause, 'The file could not be sent.') });
      return null;
    }
  }, []);

  const clear = useCallback(() => {
    latest.current += 1;
    setStatus({ phase: 'idle' });
  }, []);

  return { status, run, clear };
}
