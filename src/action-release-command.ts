import { main } from './action-release-cli';

void main().then((exitCode) => {
  process.exitCode = exitCode;
});
