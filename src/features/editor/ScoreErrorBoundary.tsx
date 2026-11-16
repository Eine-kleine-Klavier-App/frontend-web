import { Component, type ReactNode } from 'react';
import { useEditor } from '@/app/store';
import type { ScoreDocument } from '@/core/model/score';

interface Props {
  document: ScoreDocument;
  children: ReactNode;
}

/** A render error in the sheet would unmount the whole editor: the sheet goes empty instead, the
 *  message goes to the editor's toast, and the next document (an undo, another edit) draws again. */
export class ScoreErrorBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error): void {
    useEditor.setState({ error: `The score could not be drawn: ${error.message}` });
  }

  componentDidUpdate(previous: Props): void {
    if (this.state.failed && previous.document !== this.props.document) this.setState({ failed: false });
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}
