export const uiCss = `
:host{all:initial;color-scheme:light dark;font-family:system-ui,-apple-system,sans-serif;font-size:15px;line-height:1.5;color:var(--ink);--surface:#fff;--ink:#292a36;--muted:#5f6374;--line:#dcdeea;--accent:#5148a6;--soft:#f6f6fb;--tint:#ebe9fb;--focus:#7e90f5;--lavender:#8c81f4}
*{box-sizing:border-box}[dir=auto]{text-align:start;unicode-bidi:plaintext}button,input,select,textarea{font:inherit}button{cursor:pointer;border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:8px;padding:7px 11px}button:hover:not(:disabled){background:var(--soft)}button:disabled{opacity:.5;cursor:default}button.primary{background:#5148a6;color:#fff;border-color:#5148a6}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,a:focus-visible,summary:focus-visible{outline:3px solid var(--focus,#7e90f5);outline-offset:2px}a{color:var(--accent)}input,select,textarea{border:1px solid var(--line);border-radius:7px;padding:7px;background:var(--surface);color:var(--ink);max-width:100%}textarea{width:100%;min-height:75px}label{display:grid;gap:4px;margin:8px 0}label.check{display:flex;align-items:flex-start;gap:9px}input[type=checkbox]{margin-top:5px}h1,h2,h3,p{margin:0 0 12px}h1{font-size:1.7rem}h2{font-size:1.2rem}h3{font-size:1rem}small,.muted{color:var(--muted);font-size:.85em}.row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.between{justify-content:space-between}.stack{display:grid;gap:12px}.panel{background:var(--surface);color:var(--ink);border:1px solid var(--line);border-radius:14px;padding:18px;box-shadow:0 10px 45px #0002}.popup{width:min(430px,calc(100vw - 24px));max-height:calc(100vh - 24px);overflow:auto}.page{max-width:850px;margin:0 auto;padding:32px 20px;color:var(--ink);background:var(--surface)}.sentence{background:var(--soft);padding:12px;border-radius:8px;overflow-wrap:anywhere}.pronunciation-ipa{font-size:1.6em;line-height:1.4;color:var(--ink);overflow-wrap:anywhere}.translation{font-size:1.2em;font-weight:650}.status{padding:9px;border-radius:7px;background:var(--soft);overflow-wrap:anywhere}.error{color:#a42b1f;border-left:3px solid #a42b1f}mark{background:var(--tint,#ebe9fb);color:var(--accent,#5148a6);padding:1px 2px;border-radius:2px}details{border-top:1px solid var(--line);padding:8px 0}summary{cursor:pointer}fieldset{border:1px solid var(--line);border-radius:10px;margin:0;padding:15px}legend{font-weight:650;padding:0 6px}.preview{width:100%;height:170px;border:1px solid var(--line);border-radius:8px;background:white}.queue-item{border-bottom:1px solid var(--line);padding:14px 0}.badge{border-radius:20px;background:var(--soft);padding:3px 8px;font-size:.8em}.inline-field{flex:1;min-width:130px}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}
/* Reading panel only: the toolbar popup keeps its separate compact geometry. */
.reading-popup{width:min(520px,calc(100vw - 24px));padding:20px;gap:16px;scrollbar-gutter:stable both-edges;scrollbar-width:thin}
.reading-popup p{margin:0}.reading-popup .reading-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.reading-popup .reading-heading{min-width:0;display:grid;gap:3px;flex:1}.reading-popup .reading-eyebrow{display:block;color:var(--muted);font-size:12px;font-weight:550;letter-spacing:.02em}.reading-popup .reading-expression{font-size:28px;line-height:1.2;font-weight:700;overflow-wrap:anywhere}.reading-popup .reading-pos{font-size:13px}.reading-popup .reading-header-actions{display:flex;gap:7px;flex:none}.reading-popup .verb-base-form{margin-top:-7px;overflow-wrap:anywhere;font-size:17px}.reading-popup .verb-base-form bdi{font-weight:650}.reading-popup .translation{font-size:22px;line-height:1.35;font-weight:650}.reading-popup .pronunciation{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:baseline;margin-top:-7px}.reading-popup .pronunciation-ipa{font-size:19px}.reading-popup .reading-language{font-size:12px;margin-top:-9px}.reading-popup .reading-english-usage{padding:9px 12px;border:1px solid var(--line);border-radius:8px;background:var(--soft);font-size:13px}.reading-english-usage dl{display:grid;gap:3px;margin:5px 0 0}.reading-english-usage dl>div{display:flex;flex-wrap:wrap;column-gap:10px;justify-content:space-between}.reading-english-usage dt{color:var(--muted)}.reading-english-usage dd{margin:0;font-weight:550}.reading-popup .reading-context{display:grid;gap:7px;min-width:0}.reading-popup .sentence{line-height:1.65;padding:13px 14px}.reading-popup .reading-state{display:grid;gap:16px;padding:16px;border:1px solid var(--line);border-radius:12px;background:var(--soft)}.reading-popup .reading-state-title{font-weight:650;font-size:17px;line-height:1.4}.reading-popup .reading-state-message{font-size:14px;margin-top:6px;color:var(--muted)}.reading-popup .reading-loading{display:flex;align-items:flex-start;gap:12px;padding:18px 16px}.reading-popup .reading-loading .muted{margin-top:4px}.reading-popup .reading-state-dot{width:9px;height:9px;margin-top:8px;border-radius:50%;background:var(--accent);flex:none}.reading-popup .reading-retry{display:grid;justify-items:start;gap:8px}.reading-popup .reading-retry button{min-height:40px;padding:8px 16px}.reading-popup .reading-error-details{padding:10px 0 0;font-size:12px}.reading-popup .reading-error-details small{display:block;margin-top:5px;font-size:12px;overflow-wrap:anywhere}.reading-popup .reading-notice{border-left:3px solid var(--line);padding:9px 12px;background:var(--soft);border-radius:6px;font-size:13px;color:var(--muted)}.reading-popup .reading-save-actions{padding-top:4px}.reading-popup .reading-save-actions .primary{min-height:40px}.reading-popup .reading-shortcut{border-top:1px solid var(--line);padding-top:12px;font-size:12px}.reading-popup details summary{font-weight:550}.reading-popup details>p{margin-top:9px}.reading-popup fieldset{min-width:0}
@media(max-width:400px){.reading-popup{padding:16px;gap:14px}.reading-popup .reading-expression{font-size:25px}.reading-popup .reading-header{gap:10px}.reading-popup .reading-retry{justify-items:stretch}}
.anki-legacy-recovery{margin-top:12px}
.settings-notifications{position:fixed;z-index:1000;top:max(12px,env(safe-area-inset-top));left:12px;right:12px;display:grid;justify-items:center;pointer-events:none}
.settings-notification{display:flex;align-items:flex-start;gap:12px;width:100%;max-width:810px;padding:12px 14px;border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:10px;background:var(--surface);color:var(--ink);box-shadow:0 6px 24px #0003;pointer-events:auto}
.settings-notification.success{display:grid;grid-template-columns:36px minmax(0,1fr) 36px;align-items:center;padding-inline:11px 14px}
.settings-notification.success[data-compact]{width:fit-content;max-width:min(100%,300px);padding:6px 10px;column-gap:10px;border-left-width:1px;grid-template-columns:minmax(0,1fr) 36px}
.settings-notification.success .settings-notification-message{grid-column:2;text-align:center}
.settings-notification.success[data-compact] .settings-notification-message{grid-column:1}
.settings-notification-message{flex:1;min-width:0;max-height:min(40vh,240px);overflow:auto;overflow-wrap:anywhere;white-space:pre-wrap}
.settings-notification-message:focus-visible{outline:3px solid var(--focus,#7e90f5);outline-offset:2px}
.settings-notification button{flex:none;display:grid;place-items:center;width:36px;height:36px;padding:0;line-height:1}
.settings-notification button svg{display:block}
.settings-notification.error{color:#a42b1f;border-left-color:#a42b1f}
@media(prefers-color-scheme:dark){:host{--surface:#39393c;--ink:#f4f3f8;--muted:#c4c3cf;--line:#606069;--accent:#c6bfff;--soft:#424247;--tint:#4d4967;--focus:#a4b0ff;--lavender:#b4a7ff}.error,.settings-notification.error{color:#ffb1a6}}
button.primary:hover:not(:disabled){background:#443b92}
:host([data-book-theme]){color-scheme:light}
:host([data-book-theme="graphite"]){color-scheme:dark}
:host([data-book-theme]) .error{color:#983931;border-color:#983931}
:host([data-book-theme="graphite"]) .error{color:#ffb1a6;border-color:#ffb1a6}
.popup .preview{color-scheme:only light;background-color:white}
.reading-popup{width:min(520px,calc(100vw - 24px));gap:10px;padding:18px 20px;border-radius:14px;box-shadow:0 12px 35px #29264123}
.reading-popup .reading-header{padding-bottom:12px;border-bottom:1px solid var(--line)}
.reading-popup .reading-heading{gap:5px}
.reading-popup .reading-word{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.reading-popup .reading-expression{font-size:clamp(26px,5vw,34px);letter-spacing:-.035em;line-height:1.15}
.reading-popup .reading-editor-title{font-size:clamp(22px,4vw,28px);line-height:1.2;letter-spacing:-.03em}
.reading-popup .reading-eyebrow{font-size:10px;font-weight:720;letter-spacing:.09em;text-transform:uppercase;color:var(--muted)}
.reading-popup .reading-language{font-size:13px;margin:0;color:var(--accent)}
.reading-popup .reading-header-actions button{width:34px;height:34px;display:grid;place-items:center;padding:0;color:var(--ink)}
.reading-popup .reading-header-actions svg{display:block}
.reading-popup .reading-meaning{display:grid;gap:4px}
.reading-popup .translation{font-size:24px;line-height:1.2}
.reading-popup .pronunciation{margin:0;color:var(--muted)}
.reading-popup .pronunciation-ipa{font-size:15px;color:inherit}
.reading-popup .reading-context{gap:3px;background:var(--soft);border-inline-start:3px solid var(--lavender,#8c81f4);border-radius:7px;padding:8px 12px}
.reading-popup .sentence{padding:0;line-height:1.55}
.reading-popup details{padding:7px 0 0}
.reading-popup summary{font-size:14px}
.reading-popup .reading-extras{color:var(--muted)}
.reading-popup .reading-extras .stack{margin-top:8px;color:var(--ink)}
.reading-popup .reading-english-usage{background:none}
.reading-popup .reading-destination label,.reading-popup .reading-editor label{font-weight:650;color:var(--ink);font-size:13px}
.reading-popup input,.reading-popup select,.reading-popup textarea{font-weight:400;font-size:15px}
.reading-popup .reading-editor{display:grid;gap:6px;border:0;padding:0}
.reading-popup .reading-editor label{margin:4px 0 0}
.reading-popup .reading-notice{border-color:var(--lavender);background:none;padding:3px 8px}
.reading-popup .reading-save-actions{padding-top:12px;gap:6px;border-top:1px solid var(--line)}
.reading-popup .reading-save-actions button{font-weight:600;min-height:37px;font-size:13px}
.reading-popup .reading-preview{padding:12px;background:var(--soft);border:1px solid var(--line);border-radius:10px}
.reading-popup .reading-preview .preview{height:140px}
.reading-popup .reading-preview .preview:last-of-type{height:min(470px,62vh)}
.reading-popup .reading-shortcut{padding-top:8px}
.settings-page{max-width:1180px;min-height:100vh;display:grid;grid-template-columns:minmax(200px,25%) minmax(0,1fr);padding:0;margin:auto}
.settings-sidebar{background:var(--soft);padding:30px 14px;border-inline-end:1px solid var(--line)}
.settings-sidebar>strong,.settings-sidebar>h1{display:block;margin:0 10px 28px;letter-spacing:-.035em}
.settings-sidebar h1{font-size:29px}
.settings-sidebar nav{display:grid;gap:5px}
.settings-sidebar nav button{border:0;background:none;display:flex;align-items:center;gap:10px;text-align:left;color:var(--muted);padding:10px 12px}
.settings-sidebar nav button svg{flex:none}
.settings-sidebar nav button[aria-current=page]{background:var(--tint,#ebe9fb);color:var(--accent);font-weight:650}
.settings-content{align-content:start;min-width:0;gap:18px;padding:32px clamp(18px,3.6vw,48px)}
.settings-content>h2{font-size:clamp(26px,3vw,36px);letter-spacing:-.04em;line-height:1.2}
.settings-content>fieldset{border:0;border-bottom:1px solid var(--line);border-radius:0;padding:0 0 17px;min-width:0}
.settings-content legend{padding:0;margin-bottom:8px;font-size:21px}
.settings-content .row{gap:16px}
.settings-content label.check>input[type=checkbox]{width:16px;height:16px;flex:none;margin:.2em 0 0;padding:0;accent-color:var(--accent)}
.settings-content label:not(.check){font-weight:600}
.settings-content input,.settings-content select{min-width:0;font-weight:400}
.settings-content .settings-half{max-width:calc(50% - 8px)}
.settings-switch{display:flex;align-items:center;justify-content:space-between;gap:12px}
.settings-switch input[type=checkbox]{appearance:none;width:38px;height:22px;margin:0;padding:0;flex:none;position:relative;border-radius:20px;border:1px solid var(--muted);background:var(--line);cursor:pointer}
.settings-switch input[type=checkbox]::before{content:"";display:block;width:16px;height:16px;margin:2px;border-radius:50%;background:#fff;box-shadow:0 0 2px #29264150}
.settings-switch input[type=checkbox]:checked{background:#6259b3;border-color:#6259b3}
.settings-switch input[type=checkbox]:checked::before{transform:translateX(16px)}
.settings-content summary{color:var(--accent);font-weight:600}
.settings-footer button{font-weight:650;padding:10px 14px}
@media(max-width:720px){.settings-page{display:block}.settings-sidebar{padding:16px;border:0;border-bottom:1px solid var(--line)}.settings-sidebar>strong,.settings-sidebar>h1{margin:0 0 10px}.settings-sidebar>h1{font-size:22px}.settings-sidebar nav{display:flex;flex-wrap:wrap}.settings-sidebar nav button{font-size:13px;padding:6px}.settings-content{padding:20px 16px}.settings-content .settings-half{max-width:none}}
@media(max-width:400px){.reading-popup{padding:14px}.reading-popup .reading-save-actions button{flex:auto}.settings-content .row{gap:8px}}
@media(forced-colors:active){.settings-switch input[type=checkbox]{appearance:auto}.settings-switch input[type=checkbox]::before{display:none}}
`;
