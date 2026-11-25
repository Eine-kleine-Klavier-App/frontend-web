import { useMemo } from 'react';
import { useEditor } from '@/app/store';
import { measureBeats } from '@/core/model/contexts';
import { useNavigationValue } from '@/core/navigation/ScoreNavigation';
import { buildRoute, type Route } from '@/core/navigation/route';

const NO_ROUTE: Route = { bars: [], totalMs: 0 };

/** The bars of the open score in the order they are played; empty until the playback plan is loaded. */
export function useRoute(): Route {
  const map = useNavigationValue((state) => state.map);
  const measures = useEditor((state) => state.document.measures);
  return useMemo(() => (map ? buildRoute(map, measures.map((measure) => measureBeats(measure.timeSignature))) : NO_ROUTE), [map, measures]);
}
