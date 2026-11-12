import styles from '@/components/layout/Footer.module.css';
import { isExternal } from '@/components/SiteLink';
import type { PortalSiteData } from '@/lib/hub';
import { brandImages } from '@/lib/brand';
import { copyright, text } from '@/lib/site';

/** The old site's swizzled footer: logos left, link columns and copyright right. */
export function Footer({ site, locale }: { site: PortalSiteData; locale: string }) {
  const { footer } = site.navigation;
  const images = brandImages(site);
  const t = (v: Record<string, string> | undefined) => text(v, locale, site.defaultLocale);
  const copy = copyright(t(footer.copyright));
  return (
    <footer className={styles.footer}>
      <div className={styles.footerBackground}>
        {images.tech && <img src={images.tech} alt="" className={styles.techImage} />}
      </div>
      <div className={styles.footerContent}>
        <div className={styles.footerLeft}>
          {images.mark && <img src={images.mark} alt={images.alt} className={styles.milvaImage} />}
          {images.wordmark && (
            <img src={images.wordmark} alt={images.alt} className={styles.milvaHorizImage} />
          )}
        </div>
        <div className={styles.footerRight}>
          <div className={styles.linksContainer}>
            {footer.columns.map((column) => (
              <div key={column.id} className={styles.linkColumn}>
                <h4 className={styles.linkTitle}>{t(column.title)}</h4>
                <ul className={styles.linkList}>
                  {column.items.map((item) => {
                    const href = item.href ?? '#';
                    return (
                      <li key={item.id}>
                        <a
                          href={href}
                          className={styles.linkItem}
                          {...(isExternal(href)
                            ? { target: '_blank', rel: 'noopener noreferrer' }
                            : {})}
                        >
                          {t(item.label)}
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
          {copy && <div className={styles.copyright}>{copy}</div>}
        </div>
      </div>
      <div className={styles.topBorder} />
    </footer>
  );
}
