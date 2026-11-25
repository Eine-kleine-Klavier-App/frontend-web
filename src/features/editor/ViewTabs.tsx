import { ChoiceGroup } from '@/ui/ChoiceGroup';

export type ScreenView = 'editor' | 'waterfall' | 'practice';

const VIEWS: { value: ScreenView; label: string }[] = [
  { value: 'editor', label: 'Score' },
  { value: 'waterfall', label: 'Waterfall' },
  { value: 'practice', label: 'Practice' },
];

/**
 * The bar's last item on every screen of one score: Score, Waterfall and, for a score that is only read, Practice. The same
 * control in the same place wherever it is; practice is not offered while the score is being edited.
 */
export function ViewTabs({ value, onChange, practice }: {
  value: ScreenView;
  onChange: (view: ScreenView) => void;
  /** the score is read, not edited: practice is a place to go to */
  practice: boolean;
}) {
  return <ChoiceGroup<ScreenView> value={value} onChange={onChange} options={practice ? VIEWS : VIEWS.slice(0, 2)} ariaLabel="View" variant="tabs" />;
}
