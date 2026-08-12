import { useMemo } from 'react';
import { Button } from '@/ui/Button';
import { useAuthPrompt } from '@/core/auth/authPrompt';
import { getGlyphMarkup } from '@/rendering/vexflow/clefGlyph';
import { BrandMark } from '@/ui/icons';

/** The in-system sign-in state for personal screens shown to anonymous visitors (Library, You).
 *  A centered paper card with a faint engraved-clef watermark (the same signature as the browse
 *  hero/covers) so the space reads as deliberate, not empty — one shared component keeps every
 *  such screen identical. */
export function SignInPrompt({ title, subtitle }: { title: string; subtitle: string }) {
  const open = useAuthPrompt((s) => s.open);
  const watermark = useMemo(() => getGlyphMarkup('gClef'), []);
  return (
    <div className="signin-prompt">
      <div className="signin-prompt-card">
        {watermark && (
          <svg
            className="signin-prompt-watermark"
            viewBox={watermark.viewBox}
            preserveAspectRatio="xMidYMid meet"
            aria-hidden="true"
            dangerouslySetInnerHTML={{ __html: watermark.markup }}
          />
        )}
        <div className="signin-prompt-body">
          <div className="signin-prompt-mark" aria-hidden="true">
            <BrandMark />
          </div>
          <h2 className="signin-prompt-title">{title}</h2>
          <p className="signin-prompt-sub">{subtitle}</p>
          <Button variant="primary" onClick={() => open()}>
            Sign in
          </Button>
        </div>
      </div>
    </div>
  );
}
