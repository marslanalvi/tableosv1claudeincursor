/** field-ui ships plain TS (no CSS modules), so styles are injected once. */
const CSS = `
.tfu-pill{display:inline-flex;align-items:center;max-width:100%;padding:0 8px;border-radius:999px;font-size:12px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:none}
.tfu-pills{display:flex;gap:4px;align-items:center;overflow:hidden;min-width:0}
.tfu-wrap .tfu-pills{flex-wrap:wrap}
.tfu-chip{display:inline-flex;align-items:center;gap:4px;max-width:100%;padding:0 6px;border-radius:4px;background:#e8eef7;color:#1e3a5f;font-size:12px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:none}
.tfu-chip-x{border:none;background:transparent;cursor:pointer;color:inherit;opacity:.6;padding:0 0 0 2px;font:inherit;line-height:1}
.tfu-chip-x:hover{opacity:1}
.tfu-avatar{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;background:#181d26;color:#fff;font-size:10px;font-weight:500;flex:none}
.tfu-user{display:inline-flex;align-items:center;gap:4px;padding:0 6px 0 0;border-radius:999px;background:#eef2f7;font-size:12px;line-height:18px;white-space:nowrap;flex:none}
.tfu-check{display:inline-flex;width:16px;height:16px;border-radius:4px;align-items:center;justify-content:center;flex:none}
.tfu-check.on{background:#39bf45;color:#fff}
.tfu-check.off{border:1.5px solid #9297a0}
.tfu-stars{display:inline-flex;gap:1px;color:#f5a623;letter-spacing:0;flex:none}
.tfu-star{cursor:inherit;border:none;background:transparent;padding:0 1px;font-size:14px;line-height:1;color:#d7dbe0}
.tfu-star.on{color:#f5a623}
button.tfu-star{cursor:pointer}
.tfu-link{color:#1b61c9;text-decoration:underline;text-underline-offset:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tfu-thumb{width:auto;height:22px;max-width:44px;border-radius:3px;object-fit:cover;border:1px solid #dddddd;flex:none;background:#f8fafc}
.tfu-file{display:inline-flex;align-items:center;justify-content:center;height:22px;min-width:22px;padding:0 4px;border-radius:3px;border:1px solid #dddddd;background:#f8fafc;font-size:10px;color:#41454d;flex:none;text-transform:uppercase}
.tfu-error{color:#dc2626;font-size:12px}
.tfu-muted{color:#9297a0}
.tfu-num{display:block;width:100%;text-align:right;font-variant-numeric:tabular-nums}
.tfu-btn{border:1px solid #dddddd;background:#fff;color:#181d26;border-radius:6px;padding:2px 10px;font:inherit;font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap}
.tfu-btn:active{background:#e0e2e6}
.tfu-btn-primary{background:#181d26;border-color:#181d26;color:#fff}
.tfu-btn-primary:active{background:#0d1218}
.tfu-btn-danger{color:#dc2626}
.tfu-input{width:100%;box-sizing:border-box;border:1px solid #dddddd;border-radius:6px;padding:6px 8px;font:inherit;font-size:13px;background:#fff;color:inherit;outline:none}
.tfu-input:focus{border-color:#458fff;box-shadow:0 0 0 3px rgba(69,143,255,.2)}
.tfu-cell-input{width:100%;height:100%;box-sizing:border-box;border:none;outline:none;padding:0 8px;font:inherit;background:#fff;color:inherit}
.tfu-cell-area{position:absolute;left:-2px;top:-2px;z-index:20;min-width:calc(100% + 4px);width:340px;min-height:140px;box-sizing:border-box;border:2px solid #458fff;border-radius:4px;padding:6px 8px;font:inherit;background:#fff;color:inherit;outline:none;resize:both;box-shadow:0 8px 24px rgba(15,23,42,.18)}
.tfu-pop{position:fixed;z-index:1000;background:#fff;border:1px solid #dddddd;border-radius:10px;box-shadow:0 4px 16px rgba(24,29,38,.12);padding:6px;min-width:220px;max-width:360px;max-height:340px;display:flex;flex-direction:column;gap:4px;font-size:13px;color:#181d26}
.tfu-pop-list{overflow:auto;display:flex;flex-direction:column;gap:1px;min-height:0}
.tfu-pop-item{display:flex;align-items:center;gap:8px;border:none;background:transparent;text-align:left;padding:5px 6px;border-radius:5px;font:inherit;cursor:pointer;color:inherit;min-height:28px}
.tfu-pop-item:hover,.tfu-pop-item.active{background:#f8fafc}
.tfu-pop-empty{padding:6px;color:#9297a0;font-size:12px}
.tfu-form-box{display:flex;flex-wrap:wrap;gap:4px;align-items:center;min-height:34px;box-sizing:border-box;border:1px solid #dddddd;border-radius:6px;padding:4px 6px;background:#fff;cursor:pointer}
.tfu-form-box:hover{border-color:#9297a0}
.tfu-cell-box{display:flex;flex-wrap:wrap;gap:4px;align-items:flex-start;align-content:flex-start;min-height:100%;box-sizing:border-box;padding:6px 8px;background:#fff}
.tfu-modal-back{position:fixed;inset:0;z-index:1100;background:rgba(24,29,38,.4);display:flex;align-items:flex-start;justify-content:center;padding-top:10vh}
.tfu-modal{background:#fff;border-radius:12px;box-shadow:0 8px 32px rgba(24,29,38,.18);width:min(560px,92vw);max-height:70vh;display:flex;flex-direction:column;overflow:hidden;color:#181d26;font-size:13px}
.tfu-modal-head{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid #dddddd}
.tfu-modal-body{overflow:auto;padding:6px}
.tfu-rec{display:flex;flex-direction:column;align-items:flex-start;gap:2px;width:100%;border:1px solid #dddddd;background:#fff;border-radius:8px;padding:8px 10px;margin:4px 0;text-align:left;cursor:pointer;font:inherit;color:inherit}
.tfu-rec:hover{border-color:#9297a0;background:#f8fafc}
.tfu-rec.sel{border-color:#1b61c9;background:#f2f7ff}
.tfu-rec-sub{color:#41454d;font-size:12px}
.tfu-cfg{display:flex;flex-direction:column;gap:10px;font-size:13px}
.tfu-cfg label{display:flex;flex-direction:column;gap:4px;font-weight:500;color:#333840}
.tfu-cfg .tfu-row{display:flex;gap:8px;align-items:center}
.tfu-cfg .tfu-inline{flex-direction:row;align-items:center;gap:8px;font-weight:400}
.tfu-opt-row{display:flex;gap:6px;align-items:center}
.tfu-opt-row .tfu-input{flex:1}
.tfu-swatch{width:20px;height:20px;border-radius:50%;border:1px solid rgba(0,0,0,.1);cursor:pointer;flex:none;padding:0}
.tfu-swatch.sel{outline:2px solid #181d26;outline-offset:1px}
.tfu-icon-btn{border:none;background:transparent;cursor:pointer;padding:2px 4px;border-radius:4px;color:#41454d;font:inherit}
.tfu-icon-btn:hover{background:#f1f5f9;color:#181d26}
.tfu-icon-btn:disabled{opacity:.3;cursor:default}
.tfu-formula{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;min-height:80px;resize:vertical}
.tfu-ok{color:#059669;font-size:12px}
.tfu-preview{background:#f8fafc;border:1px solid #dddddd;border-radius:6px;padding:6px 8px;font-size:12px}
.tfu-attach-grid{display:flex;flex-wrap:wrap;gap:8px}
.tfu-attach{position:relative;width:84px;display:flex;flex-direction:column;gap:2px;font-size:11px}
.tfu-attach-img{width:84px;height:64px;border-radius:6px;border:1px solid #dddddd;object-fit:cover;background:#f8fafc;display:flex;align-items:center;justify-content:center;color:#41454d;text-transform:uppercase;font-size:11px}
.tfu-attach-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tfu-attach-x{position:absolute;top:2px;right:2px;width:18px;height:18px;border-radius:50%;border:none;background:rgba(15,23,42,.65);color:#fff;cursor:pointer;font-size:12px;line-height:18px;padding:0}
`;

let injected = false;

export function ensureFieldUiStyles(): void {
  if (injected || typeof document === "undefined") return;
  injected = true;
  if (document.getElementById("tabula-field-ui-styles")) return;
  const el = document.createElement("style");
  el.id = "tabula-field-ui-styles";
  el.textContent = CSS;
  document.head.appendChild(el);
}
