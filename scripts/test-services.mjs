import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const paths=readdirSync('tests').filter(n=>n.endsWith('.test.ts')).map(n=>`tests/${n}`);
const result=spawnSync(process.execPath,['--test',...paths],{stdio:'inherit'});
process.exit(result.status??1);
