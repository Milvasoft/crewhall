/** localStorage key of the colour mode (same as Docusaurus). */
export const THEME_STORAGE_KEY = 'theme';

/**
 * Runs in <head> before the first paint: applies the stored choice or the system preference to
 * <html data-theme> and data-theme-choice, so there is no flash of the wrong theme.
 */
export const THEME_SCRIPT = `(function(){var c=null;try{c=window.localStorage.getItem('${THEME_STORAGE_KEY}')}catch(e){}var choice=c==='light'||c==='dark'?c:'system';var dark=choice==='dark'||(choice==='system'&&window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);var d=document.documentElement;d.setAttribute('data-theme',dark?'dark':'light');d.setAttribute('data-theme-choice',choice)})();`;
