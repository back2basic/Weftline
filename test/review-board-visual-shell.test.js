import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {reviewBoardPage} from '../experimental/review-v1-ui.js';

test('review board delivers a responsive, CSP-authorized visual shell without changing safety labels',()=>{
 const {html,csp}=reviewBoardPage('b');
 assert.match(html,/<meta name="viewport" content="width=device-width, initial-scale=1">/);
 assert.match(html,/<h1>Weftline<\/h1>/);
 assert.match(html,/advisory and possibly stale/);
 assert.match(html,/State: unknown/);
 const styles=[...html.matchAll(/<style>([\s\S]*?)<\/style>/g)];
 assert.equal(styles.length,1);
 assert.match(styles[0][1],/@media\s*\(max-width:\s*600px\)/);
 assert.match(styles[0][1],/:focus-visible/);
 const hash=createHash('sha256').update(styles[0][1]).digest('base64');
 assert.ok(csp.includes(`style-src 'sha256-${hash}'`));
 assert.doesNotMatch(csp,/'unsafe-inline'/);
});
