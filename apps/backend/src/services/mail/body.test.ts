import { describe, expect, it } from 'vitest';
import { decodeCharset, decodeTransfer } from './body';
import { attachmentsOf, bodyParts, partsOf } from './structure';

describe('mail body parts', () => {
  it('undoes quoted-printable and base64, then the charset', () => {
    const qp = Buffer.from('=C3=87a=C4=9Fr=C4=B1 =3D tamam, uzun sat=\r\n=C4=B1r', 'latin1');
    expect(decodeCharset(decodeTransfer(qp, 'quoted-printable'), 'utf-8')).toBe(
      'Çağrı = tamam, uzun satır',
    );
    const b64 = Buffer.from(
      Buffer.from('ığüşöç')
        .toString('base64')
        .replace(/(.{4})/g, '$1\r\n'),
    );
    expect(decodeCharset(decodeTransfer(b64, 'base64'), null)).toBe('ığüşöç');
    // windows-1254 (Turkish): ş = 0xFE, ı = 0xFD.
    expect(decodeCharset(Buffer.from([0xfe, 0xfd]), 'windows-1254')).toBe('şı');
    expect(decodeCharset(Buffer.from('abc'), 'no-such-charset')).toBe('abc');
  });

  it('picks the text parts and inline images, lists the rest as files', () => {
    const parts = partsOf({
      type: 'multipart/mixed',
      childNodes: [
        {
          type: 'multipart/related',
          part: '1',
          childNodes: [
            {
              type: 'multipart/alternative',
              part: '1.1',
              childNodes: [
                {
                  type: 'text/plain',
                  part: '1.1.1',
                  encoding: 'quoted-printable',
                  parameters: { charset: 'UTF-8' },
                  size: 10,
                },
                { type: 'text/html', part: '1.1.2', encoding: 'base64', size: 40 },
              ],
            },
            { type: 'image/png', part: '1.2', id: '<Logo@X>', encoding: 'base64', size: 400 },
          ],
        },
        {
          type: 'application/pdf',
          part: '2',
          disposition: 'attachment',
          dispositionParameters: { filename: 'teklif.pdf' },
          encoding: 'base64',
          size: 4000,
        },
      ],
    });
    const body = bodyParts(parts);
    expect([body.html?.part, body.text?.part, body.inline.map((p) => p.part)]).toEqual([
      '1.1.2',
      '1.1.1',
      ['1.2'],
    ]);
    expect(body.text?.charset).toBe('utf-8');
    expect(attachmentsOf(parts)).toEqual([
      { part: '1.2', filename: 'attachment-1', contentType: 'image/png', size: 300, inline: true },
      {
        part: '2',
        filename: 'teklif.pdf',
        contentType: 'application/pdf',
        size: 3000,
        inline: false,
      },
    ]);
  });

  it('treats a single-part message as one body part', () => {
    const parts = partsOf({ type: 'text/plain', encoding: '7bit', size: 5 });
    expect(parts).toMatchObject([{ part: '1', type: 'text/plain' }]);
    expect(bodyParts(parts).text?.part).toBe('1');
  });
});
