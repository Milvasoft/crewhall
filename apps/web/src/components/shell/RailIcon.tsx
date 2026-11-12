import { cn, Icon } from '@crewhall/ui';
import { useState } from 'react';
import type { RailEntry } from './Rail';

/**
 * A left menu entry's icon: a plugin's own picture when it has one, else the line icon. The picture
 * lives on the plugin's server, so the line icon also stands in when it does not load.
 */
export function RailIcon({
  entry,
  size,
  className,
}: {
  entry: Pick<RailEntry, 'icon' | 'iconUrl'>;
  size: number;
  className?: string;
}) {
  const url = entry.iconUrl;
  const [failed, setFailed] = useState<string | null>(null);
  if (!url || failed === url) return <Icon name={entry.icon} size={size} className={className} />;
  return (
    <img
      src={url}
      alt=""
      referrerPolicy="no-referrer"
      draggable={false}
      onError={() => setFailed(url)}
      style={{ width: size, height: size }}
      className={cn('rounded-[22%] object-contain', className)}
    />
  );
}
