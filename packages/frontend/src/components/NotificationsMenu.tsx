import React from 'react';
import { ArrowDownLeft, ArrowUpRight, Bell, CheckCircle2, Clock3, Link2, ShieldCheck } from 'lucide-react';
import { HeaderPopover } from './HeaderPopover.js';
import type { ActivityNotice } from '../services/activityNotices.js';

const icons = { transfer: ArrowUpRight, confirmation: CheckCircle2, signing: ShieldCheck, connection: Link2, resolution: ArrowDownLeft };

export function NotificationsMenu({ open, onOpenChange, notices, onRead }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  notices: ActivityNotice[];
  onRead: () => void;
}) {
  const unread = notices.filter(notice => !notice.read).length;
  return <HeaderPopover label="Notifications" triggerLabel={unread ? `Notifications, ${unread} unread` : 'Notifications'}
    open={open} onOpenChange={onOpenChange} triggerClass="header-icon-button header-notification-trigger"
    focusKey={unread ? 'unread' : 'read'}
    trigger={<><Bell size={19} aria-hidden="true" />{unread > 0 && <span className="notification-dot" aria-hidden="true" />}</>}>
    <div className="header-popover-heading">
      <h2>Notifications</h2>
      {unread > 0 && <button type="button" className="btn notification-read" onClick={onRead}>Mark all as read</button>}
    </div>
    {notices.length ? <ul className="header-notice-list">
      {notices.map(notice => {
        const Icon = icons[notice.kind];
        return <li key={notice.id} data-unread={!notice.read || undefined}>
          <span className="header-notice-icon"><Icon size={16} aria-hidden="true" /></span>
          <div>
            <strong>{notice.title}</strong>
            {notice.detail && <p>{notice.detail}</p>}
            <time dateTime={new Date(notice.timeMs).toISOString()}><Clock3 size={11} aria-hidden="true" />{new Date(notice.timeMs).toLocaleString()}</time>
          </div>
        </li>;
      })}
    </ul> : <p className="header-notice-empty">No notifications yet.</p>}
  </HeaderPopover>;
}
