import type { LibraryGateway } from './LibraryGateway';
import { HttpLibraryGateway } from './HttpLibraryGateway';

// Shared API gateway for catalog and draft listings.
export const libraryGateway: LibraryGateway = new HttpLibraryGateway();
