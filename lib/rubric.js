const CRITERIA = [
  {
    key: 'technical',
    label: 'Technical Difficulty',
    shortLabel: 'Technical',
    levels: [
      {
        value: 1,
        anchor: 'Project has little to no customization and no working features. It relies heavily on an existing framework (WordPress, Unreal Engine, and similar tools) or a template.'
      },
      {
        value: 2,
        anchor: 'The team has a good start, but there is very little to show. Maybe a good UI and the idea for some features.'
      },
      {
        value: 3,
        anchor: 'Project shows a moderate degree of difficulty. Features do not work properly.'
      },
      {
        value: 4,
        anchor: 'Project has a high degree of difficulty. One or two features are missing or do not function properly, or the project needs some polish. Scope was ambitious.'
      },
      {
        value: 5,
        anchor: 'Project has a very high degree of complexity. The team tackled a very ambitious scope or technical features and achieved the goals they set out to accomplish in 24 hours.'
      }
    ]
  },
  {
    key: 'aesthetics',
    label: 'Aesthetics (Design/UI/UX)',
    shortLabel: 'Aesthetics',
    levels: [
      {
        value: 1,
        anchor: 'UI is difficult to use. It is not intuitive or clear, or it is sloppy or just out of the box. Poor color choices and design elements.'
      },
      {
        value: 2,
        anchor: 'UI is usable but not intuitive, and it does not have clear instructions. Fair color choices and design elements.'
      },
      {
        value: 3,
        anchor: 'UI is usable. The flow, ease of use, and clarity still need some work.'
      },
      {
        value: 4,
        anchor: 'UI is well-designed. It is close, but still needs some work on clarity and ease of use.'
      },
      {
        value: 5,
        anchor: 'UI is attractive and very intuitive. The flow of the app makes sense, and it is clear and easy to use at first glance.'
      }
    ]
  },
  {
    key: 'uniqueness',
    label: 'Uniqueness (Wow factor)',
    shortLabel: 'Uniqueness',
    levels: [
      {
        value: 1,
        anchor: 'There is an existing application that accomplishes the same thing using similar functionality.'
      },
      {
        value: 2,
        anchor: 'Project provides a better, faster, clearer way to attack an existing problem than the existing solution.'
      },
      {
        value: 3,
        anchor: 'Project provides a better, faster, clearer way to solve an existing problem when compared with existing solutions.'
      },
      {
        value: 4,
        anchor: 'Project tackles an overlooked or ignored problem, or attacks an existing problem in a new way that is better, faster, or clearer.'
      },
      {
        value: 5,
        anchor: 'The project attacks a new problem and provides a creative and innovative solution.'
      }
    ]
  },
  {
    key: 'viability',
    label: 'Viability',
    shortLabel: 'Viability',
    levels: [
      {
        value: 1,
        anchor: 'Project is similar or exactly like an existing product.'
      },
      {
        value: 2,
        anchor: 'Project is on the right track but needs more time in product development. It is difficult to use or scale.'
      },
      {
        value: 3,
        anchor: 'Project shows potential. It is incomplete, with missing components or a clunky design.'
      },
      {
        value: 4,
        anchor: 'Project has a practical application, fills a market need, and with some additional development could acquire users.'
      },
      {
        value: 5,
        anchor: 'Project could go to market today. It fills a market need and could acquire active users today.'
      }
    ]
  }
];

const RUBRIC_MAX = CRITERIA.length * 5;

const compositeScore = (values) => {
  return CRITERIA.reduce((sum, criterion) => sum + Number(values[criterion.key]), 0);
};

const parseRubricInput = (body) => {
  const source = body || {};
  const values = {};

  for (const criterion of CRITERIA) {
    const text = String(source[criterion.key] == null ? '' : source[criterion.key]).trim();
    if (!/^[1-5]$/.test(text)) {
      return {
        ok: false,
        message: `Choose a score from 1 to 5 for ${criterion.label}.`
      };
    }
    values[criterion.key] = Number(text);
  }

  return { ok: true, values, total: compositeScore(values) };
};

const rubricFields = (values) => {
  const selected = values || {};
  return CRITERIA.map((criterion) => {
    const current = Number(selected[criterion.key]);
    const levels = criterion.levels.map((level) => ({
      value: level.value,
      anchor: level.anchor,
      selected: current === level.value
    }));
    const chosen = levels.find((level) => level.selected);
    return {
      key: criterion.key,
      label: criterion.label,
      levels,
      selectedAnchor: chosen ? chosen.anchor : 'Choose a score from 1 to 5.'
    };
  });
};

const rubricBreakdown = (values) => {
  if (!values) return [];
  return CRITERIA.reduce((items, criterion) => {
    const value = Number(values[criterion.key]);
    if (!Number.isInteger(value)) return items;
    items.push({
      key: criterion.key,
      label: criterion.shortLabel,
      value
    });
    return items;
  }, []);
};

module.exports = {
  CRITERIA,
  RUBRIC_MAX,
  compositeScore,
  parseRubricInput,
  rubricFields,
  rubricBreakdown
};
