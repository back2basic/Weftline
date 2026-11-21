import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
export function ephemeralTls(){
 const dir=mkdtempSync(join(tmpdir(),'weftline-tls-'));
 try {execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem'),'-days','1','-subj','/CN=localhost'],{stdio:'ignore'});return {key:readFileSync(join(dir,'key.pem')),cert:readFileSync(join(dir,'cert.pem'))};}
 finally {rmSync(dir,{recursive:true,force:true});}
}
