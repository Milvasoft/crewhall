import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MediaViewer, type ViewerItem } from './viewer';

const labels = {
  close: 'Kapat',
  prev: 'Önceki',
  next: 'Sonraki',
  zoomIn: 'Yakınlaştır',
  zoomOut: 'Uzaklaştır',
  download: 'İndir',
  openInTab: 'Yeni sekmede aç',
  copyLink: 'Linki kopyala',
  counter: (i: number, n: number) => `${i} / ${n}`,
  noPreview: 'Önizleme yok',
};

const items: ViewerItem[] = [
  { key: 'a', name: 'bir.png', kind: 'image', src: '/a.png', thumb: '/a-small.png' },
  { key: 'b', name: 'iki.png', kind: 'image', src: '/b.png' },
  { key: 'c', name: 'rapor.pdf', kind: 'pdf', src: '/c.pdf' },
];

function Harness({ onDownload }: { onDownload?: (i: ViewerItem) => void }) {
  const [open, setOpen] = useState(true);
  const [index, setIndex] = useState(0);
  return (
    <MediaViewer
      open={open}
      onOpenChange={setOpen}
      items={items}
      index={index}
      onIndexChange={setIndex}
      labels={labels}
      onDownload={onDownload}
      reducedMotion
    />
  );
}

describe('MediaViewer', () => {
  it('shows the item with its counter and moves with the arrow keys and buttons', async () => {
    render(<Harness />);
    const user = userEvent.setup();
    const dialog = screen.getByRole('dialog', { name: 'bir.png' });
    expect(dialog).toHaveTextContent('1 / 3');
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('dialog', { name: 'iki.png' })).toHaveTextContent('2 / 3');
    await user.click(screen.getByRole('button', { name: 'Sonraki' }));
    expect(screen.getByTitle('rapor.pdf')).toHaveAttribute('src', '/c.pdf');
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(screen.getByRole('dialog', { name: 'bir.png' })).toBeInTheDocument();
  });

  it('loads the thumbnail first and the full image over it', () => {
    render(<Harness />);
    const imgs = screen.getByTestId('viewer-image').querySelectorAll('img');
    expect(imgs[0]).toHaveAttribute('src', '/a-small.png');
    expect(imgs[1]).toHaveAttribute('src', '/a.png');
    expect(imgs[1]).toHaveClass('opacity-0');
  });

  it('zooms with the buttons and calls the download handler', async () => {
    const onDownload = vi.fn();
    render(<Harness onDownload={onDownload} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Yakınlaştır' }));
    expect(screen.getByText('125%')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'İndir' }));
    expect(onDownload).toHaveBeenCalledWith(expect.objectContaining({ key: 'a' }));
  });

  it('closes with the X button and with Esc', async () => {
    const { unmount } = render(<Harness />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Kapat' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    unmount();
    render(<Harness />);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
