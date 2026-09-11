import { createExecutionStore, createCoordinatorOwner } from '../../../src/lib/execution-store.ts';

process.on('message', message => {
  if (message.kind === 'start') {
    const store = createExecutionStore({ stateRoot: message.root, repo: message.repo });
    try {
      const owner = store.acquire(createCoordinatorOwner(message.session, `child-${process.pid}`));
      process.send({ kind: 'acquired', owner });
    } catch (error) {
      process.send({ kind: error.kind ?? 'error', message: error.message });
    }
  } else if (message.kind === 'exit') process.exit(0);
});
process.send({ kind: 'ready' });
