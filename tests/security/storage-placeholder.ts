// Resolution target only for isolated host tests. Runtime implementation is mocked by the test.
export function openReaderStorage(): never { throw new Error('Host test must explicitly mock storage'); }
