import type { LibraryGateway } from './LibraryGateway';
import { MockLibraryGateway } from './MockLibraryGateway';

// The one swap point for Explore/Library, same pattern as store.ts's EditorGateway singleton —
// becomes `new HttpLibraryGateway()` once real listing endpoints exist, no caller changes.
// NOT named `libraryGateway.ts` — macOS's default case-insensitive filesystem treats that as
// the SAME file as `LibraryGateway.ts` and silently clobbers it (hit this exact bug once already).
export const libraryGateway: LibraryGateway = new MockLibraryGateway();
