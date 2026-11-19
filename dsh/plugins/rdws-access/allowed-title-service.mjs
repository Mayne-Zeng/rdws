import { loadNativeTitlePackage } from './title-binding.mjs';

const { default: SessionTitleService } = await loadNativeTitlePackage(
  '@deepseek-ai/dsh-session-title',
);

export default class AllowedTitleService extends SessionTitleService {
  async refresh() {
    throw new Error(
      'Manual title generation is disabled in this managed runtime',
    );
  }
}
