import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { NODE } from '@/mocks/driveSeed';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

// Excalidraw does not load in jsdom; the toolbar around it is what this test needs.
vi.mock('@excalidraw/excalidraw', () => ({
  Excalidraw: () => null,
  CaptureUpdateAction: { IMMEDIATELY: 'IMMEDIATELY', NEVER: 'NEVER', EVENTUALLY: 'EVENTUALLY' },
  FONT_FAMILY: { Nunito: 6 },
}));
vi.mock('@excalidraw/excalidraw/index.css', () => ({}));

/** "Paylaş" in the drawing editor opens Drive's share dialog for the drawing's node. */
describe('drawing share', () => {
  it('opens the Drive share dialog for the drawing', async () => {
    signedInAs(USER.bugra);
    renderApp(`/d/${NODE.hubMimarisi}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Paylaş' }));
    const dialog = await screen.findByRole('dialog', { name: /Hub mimarisi.*paylaş/ });
    expect(dialog).toBeInTheDocument();
  });
});
