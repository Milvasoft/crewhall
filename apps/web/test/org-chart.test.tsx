import { type OrgChartNode } from '@crewhall/shared';
import { Toaster } from '@crewhall/ui';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import {
  chartIsFlat,
  chartModel,
  chartSvg,
  descendantsOf,
  exportRows,
  pdfFromJpeg,
} from '@/lib/contacts/chart';
import { directoryCsv } from '@/components/contacts/ImportDirectoryDialog';
import { contactsMockState, resetContactsMock } from '@/mocks/contacts';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

const node = (
  id: string,
  name: string,
  managerId: string | null,
  extra: Partial<OrgChartNode> = {},
): OrgChartNode => ({
  user: { id, name, email: `${id}@x.com`, imageUrl: null },
  title: null,
  department: null,
  managerId,
  reportCount: 0,
  ...extra,
});

const people = [
  node('a', 'Ayşe', null, { department: 'Yönetim' }),
  node('b', 'Burak', 'a', { department: 'Ürün', team: 'Portal' }),
  node('c', 'Cem', 'b', { department: 'Ürün', team: 'Portal' }),
  node('d', 'Deniz', 'a', { department: 'Ürün', title: 'Tasarımcı <UX>' }),
  node('e', 'Ece', null),
];

describe('org chart model (sonraki-isler)', () => {
  it('draws the manager tree and groups by department with managers inside the group', () => {
    const tree = chartModel(people, 'manager');
    expect(tree.sections).toHaveLength(1);
    expect(tree.sections[0]!.roots.map((n) => n.user.name)).toEqual(['Ayşe', 'Ece']);
    expect(tree.childrenOf('a').map((n) => n.user.name)).toEqual(['Burak', 'Deniz']);

    const byDept = chartModel(people, 'department');
    expect(byDept.sections.map((s) => [s.key, s.roots.map((n) => n.user.name), s.size])).toEqual([
      ['Ürün', ['Burak', 'Deniz'], 3],
      ['Yönetim', ['Ayşe'], 1],
      [null, ['Ece'], 1],
    ]);
    // Cem stays under Burak (same department); Burak is no longer under Ayşe there.
    expect(byDept.childrenOf('b').map((n) => n.user.name)).toEqual(['Cem']);
    expect(byDept.childrenOf('a')).toEqual([]);
  });

  it('knows who cannot become a manager and when the chart is still flat', () => {
    expect([...descendantsOf(people, 'b')].sort()).toEqual(['b', 'c']);
    expect([...descendantsOf(people, 'a')].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(chartIsFlat(people)).toBe(false);
    expect(chartIsFlat(people.map((n) => ({ ...n, managerId: null })))).toBe(true);
  });

  it('exports every row as an SVG with escaped text and a one-page PDF', () => {
    const rows = exportRows(chartModel(people, 'manager'), 'Yok');
    expect(rows.map((r) => [r.depth, r.name])).toEqual([
      [0, 'Ayşe'],
      [1, 'Burak'],
      [2, 'Cem'],
      [1, 'Deniz'],
      [0, 'Ece'],
    ]);
    const { svg, height } = chartSvg(rows, 'Şema & ekip');
    expect(svg).toContain('Şema &amp; ekip');
    expect(svg).toContain('Tasarımcı &lt;UX&gt;');
    expect(height).toBe(32 * 2 + 40 + rows.length * 44);

    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const pdf = new TextDecoder('latin1').decode(
      pdfFromJpeg(jpeg, { width: 200, height: 100 }, { width: 100, height: 50 }),
    );
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf).toContain('/MediaBox [0 0 100 50]');
    expect(pdf).toContain('/Width 200 /Height 100');
    // The cross-reference table is where startxref says.
    const at = Number(/startxref\n(\d+)/.exec(pdf)![1]);
    expect(pdf.slice(at, at + 4)).toBe('xref');
  });

  it('writes a CSV template of the chart for Excel', () => {
    const csv = directoryCsv(people.slice(0, 2), [
      'E-posta',
      'Unvan',
      'Departman',
      'Ekip',
      'Yönetici',
    ]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1).split('\r\n')).toEqual([
      'E-posta;Unvan;Departman;Ekip;Yönetici',
      'a@x.com;;Yönetim;;',
      'b@x.com;;Ürün;Portal;a@x.com',
      '',
    ]);
  });
});

describe('org chart screen (sonraki-isler)', () => {
  beforeEach(() => {
    resetContactsMock();
    render(<Toaster />);
  });

  const chartView = () => screen.findByTestId('org-chart-view');

  it('explains an empty chart and leads the admin to the table', async () => {
    signedInAs(USER.bugra);
    for (const p of Object.values(contactsMockState().profiles)) p.managerId = null;
    renderApp('/contacts/org-chart');
    const view = await chartView();
    expect(within(view).getByTestId('org-chart-flat')).toHaveTextContent(
      'Şemada henüz yönetici yok',
    );
    fireEvent.click(within(view).getByRole('button', { name: 'Yöneticileri ata' }));
    expect(await within(view).findByRole('table')).toBeInTheDocument();
  });

  it('changes a manager in the table and edits a title in place', async () => {
    signedInAs(USER.bugra);
    renderApp('/contacts/org-chart');
    const user = userEvent.setup();
    const view = await chartView();
    await user.click(within(view).getByRole('radio', { name: 'Tablo' }));
    const title = within(view).getByLabelText('Zeynep Arslan · Unvan');
    await user.clear(title);
    await user.type(title, 'Kıdemli tasarımcı{enter}');
    await waitFor(() =>
      expect(contactsMockState().profiles[USER.zeynep]?.title).toBe('Kıdemli tasarımcı'),
    );
    await user.click(within(view).getByRole('combobox', { name: 'Zeynep Arslan · Yöneticisi' }));
    await user.click(await screen.findByRole('option', { name: 'Mert Aydın' }));
    await waitFor(() =>
      expect(contactsMockState().profiles[USER.zeynep]?.managerId).toBe(USER.mert),
    );
    // Mert's title comes from the directory: locked.
    expect(within(view).queryByLabelText('Mert Aydın · Unvan')).toBeNull();
  });

  it('checks a CSV first and then applies it', async () => {
    signedInAs(USER.bugra);
    renderApp('/contacts/org-chart');
    const user = userEvent.setup();
    const view = await chartView();
    await user.click(within(view).getByRole('button', { name: 'CSV ile içe aktar' }));
    const dialog = await screen.findByRole('dialog', { name: 'CSV ile içe aktar' });
    const file = new File(
      ['E-posta;Ekip;Yönetici\nzeynep@milvasoft.com;Portal;mert@milvasoft.com\nkimse@x.com;;\n'],
      'sema.csv',
      { type: 'text/csv' },
    );
    await user.upload(within(dialog).getByLabelText('CSV dosyası'), file);
    await user.click(within(dialog).getByRole('button', { name: 'Önce kontrol et' }));
    expect(await within(dialog).findByTestId('directory-import-summary')).toHaveTextContent(
      '1 güncellenecek · 0 aynı · 1 hatalı',
    );
    expect(
      within(dialog).getByText('Bu e-postayla kurumda etkin bir kişi yok.'),
    ).toBeInTheDocument();
    // The check changed nothing.
    expect(contactsMockState().profiles[USER.zeynep]?.managerId).toBe(USER.elif);
    await user.click(within(dialog).getByRole('button', { name: '1 kişiyi güncelle' }));
    await waitFor(() =>
      expect(contactsMockState().profiles[USER.zeynep]).toMatchObject({
        managerId: USER.mert,
        team: 'Portal',
      }),
    );
    expect(await screen.findByText('1 kişi güncellendi')).toBeInTheDocument();
  });

  it('lets an admin drag a person onto a new manager and undo it', async () => {
    signedInAs(USER.bugra);
    // jsdom has no layout: each person row is a 300×40 box, one under the other.
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const id = this.getAttribute('data-person');
      const rows = [...document.querySelectorAll('[data-person]')];
      const i = id ? rows.indexOf(this) : -1;
      const top = i >= 0 ? 100 + i * 50 : 0;
      const height = i >= 0 ? 40 : 0;
      return {
        left: 0,
        top,
        width: i >= 0 ? 300 : 0,
        height,
        right: i >= 0 ? 300 : 0,
        bottom: top + height,
        x: 0,
        y: top,
        toJSON: () => ({}),
      } as DOMRect;
    };
    onTestFinished(() => {
      Element.prototype.getBoundingClientRect = original;
    });
    renderApp('/contacts/org-chart');
    const user = userEvent.setup();
    const chart = await screen.findByTestId('org-chart');
    await user.click(within(chart).getByRole('button', { name: /Elif .* ekibini aç/ }));
    const rows = () => [...chart.querySelectorAll<HTMLElement>('[data-person]')];
    const rowOf = (id: string) => rows().find((r) => r.dataset.person === id)!;
    const center = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };
    const from = center(rowOf(USER.zeynep));
    const to = center(rowOf(USER.mert));
    fireEvent.mouseDown(rowOf(USER.zeynep), { clientX: from.x, clientY: from.y, button: 0 });
    fireEvent.mouseMove(document, { clientX: from.x, clientY: from.y + 10 });
    fireEvent.mouseMove(document, { clientX: to.x, clientY: to.y });
    fireEvent.mouseUp(document, { clientX: to.x, clientY: to.y });
    await waitFor(() =>
      expect(contactsMockState().profiles[USER.zeynep]?.managerId).toBe(USER.mert),
    );
    const note = (await screen.findByText('Zeynep Arslan artık Mert Aydın ekibinde')).closest(
      '[data-sonner-toast]',
    ) as HTMLElement;
    fireEvent.click(within(note).getByRole('button', { name: 'Geri al' }));
    await waitFor(() =>
      expect(contactsMockState().profiles[USER.zeynep]?.managerId).toBe(USER.elif),
    );
  });

  it('sets up the Google Workspace directory sync with a service account key', async () => {
    signedInAs(USER.bugra);
    renderApp('/admin/calendar');
    const user = userEvent.setup();
    const fields = await screen.findByTestId('workspace-fields');
    const key = new File(
      [
        JSON.stringify({
          type: 'service_account',
          client_email: 'sa@proj.iam.gserviceaccount.com',
        }),
      ],
      'anahtar.json',
      { type: 'application/json' },
    );
    const picker = within(fields)
      .getAllByLabelText('Hizmet hesabı anahtarı (JSON)')
      .find((el) => el instanceof HTMLInputElement && el.type === 'file')!;
    await user.upload(picker, key);
    expect(within(fields).getByText('Kaydedince yüklenecek: anahtar.json')).toBeInTheDocument();
    await user.type(within(fields).getByLabelText('Yönetici e-postası'), 'admin@milvasoft.com');
    await user.click(
      within(fields).getByRole('switch', { name: "Rehberi Google Workspace'ten eşitle" }),
    );
    await user.click(screen.getAllByRole('button', { name: 'Kaydet' })[0]!);
    // Saved: the card starts over from the server.
    expect(
      await screen.findByText('Yüklü anahtar: sa@proj.iam.gserviceaccount.com'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Şimdi eşitle' }));
    expect(await screen.findByText('Rehber eşitlendi')).toBeInTheDocument();
  });

  it('shows members the chart without the admin tools', async () => {
    signedInAs(USER.mert);
    renderApp('/contacts/org-chart');
    const view = await chartView();
    expect(within(view).queryByRole('button', { name: 'CSV ile içe aktar' })).toBeNull();
    expect(within(view).queryByText(/başka birinin üstüne bırakırsan/)).toBeNull();
    expect(within(view).getByRole('button', { name: 'Dışa aktar' })).toBeInTheDocument();
  });
});
