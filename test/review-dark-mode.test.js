import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as ui from '../experimental/review-v1-ui.js';

function fixture(saved=null,systemDark=false,storageFails=false){
 const root={dataset:{}},button={attributes:{},setAttribute(k,v){this.attributes[k]=v;}};
 const memory=new Map(saved===null?[]:[['weftline-theme',saved]]);
 const storage={getItem(k){if(storageFails)throw Error();return memory.get(k)??null;},setItem(k,v){if(storageFails)throw Error();memory.set(k,v);}};
 const media={matches:systemDark,addEventListener(_name,fn){this.change=fn;}};
 return {root,button,memory,storage,media,document:{documentElement:root,getElementById:id=>id==='theme-toggle'?button:null}};
}

test('theme follows the system until explicitly switched, then remembers the choice',()=>{
 assert.equal(typeof ui.installReviewTheme,'function');
 const f=fixture(null,true);ui.installReviewTheme(f.document,f.storage,f.media);
 assert.equal(f.root.dataset.theme,'dark');assert.equal(f.button.attributes['aria-pressed'],'true');
 f.button.onclick();assert.equal(f.root.dataset.theme,'light');assert.equal(f.button.attributes['aria-pressed'],'false');assert.equal(f.memory.get('weftline-theme'),'light');
 f.media.matches=true;f.media.change();assert.equal(f.root.dataset.theme,'light');
 const again=fixture(f.memory.get('weftline-theme'),true);ui.installReviewTheme(again.document,again.storage,again.media);assert.equal(again.root.dataset.theme,'light');
});

test('theme remains switchable if preference storage is unavailable',()=>{
 const f=fixture(null,false,true);ui.installReviewTheme(f.document,f.storage,f.media);assert.equal(f.root.dataset.theme,'light');f.button.onclick();assert.equal(f.root.dataset.theme,'dark');
});

test('review page exposes a focusable theme switch and the dark palette under CSP',()=>{
 const {html,csp}=ui.reviewBoardPage('b');assert.match(html,/id="theme-toggle"/);assert.match(html,/data-theme[=~|^$*\s"'a-z-]*dark/);assert.doesNotMatch(csp,/'unsafe-inline'/);
});
