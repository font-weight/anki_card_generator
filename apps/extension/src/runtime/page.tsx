import React from 'react';
import { createRoot } from 'react-dom/client';
import { uiCss } from '../ui';
export function mountPage(element: React.ReactNode, pageCss = '') {
 const host=document.getElementById('root')!;
 const shadow=host.attachShadow({mode:'open'});
 const style=document.createElement('style');style.textContent=uiCss+' :host {display:block;min-height:100vh;}' + pageCss;
 const target=document.createElement('div');shadow.append(style,target);createRoot(target).render(element);
}
