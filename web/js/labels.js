// Russian labels of vessel prototype fields (category / class / engine / group), the same dictionary as in
// SS14-MapViewer (web/js/labels.js). The builds have no locale for these enums: unknown values are shown as written.
const DICT = {
  category: {
    micro: 'Микро', small: 'Малый', medium: 'Средний', large: 'Крупный', capital: 'Капитальный',
    supercapital: 'Суперкапитал', frigate: 'Фрегат', corvette: 'Корвет', destroyer: 'Эсминец', cruiser: 'Крейсер',
  },
  class: {
    pursuit: 'Перехватчик', brawler: 'Штурмовой', patrol: 'Патрульный', corvette: 'Корвет', frigate: 'Фрегат',
    uranium: 'Урановый', plasma: 'Плазменный', ame: 'ДАМ', salvage: 'Шахтёрский', mining: 'Шахтёрский',
    expedition: 'Экспедиционный', escort: 'Эскорт', medical: 'Медицинский', chemistry: 'Химический',
    scrapyard: 'Утилизаторский', fighter: 'Истребитель', science: 'Научный', civilian: 'Гражданский',
    antishipmissilecarrier: 'Противокорабельный ракетоносец', missilecarrier: 'Ракетоносец', mechcarrier: 'Мехоносец',
    dronecarrier: 'Дрононосец', cargo: 'Грузовой', transport: 'Транспортный', syndicate: 'Синдикат',
    mercenary: 'Наёмнический', botany: 'Ботанический', earlywarning: 'ДРЛО', kitchen: 'Кухня',
    atmospherics: 'Атмосферный', pirate: 'Пиратский', detainment: 'Конвойный', engineering: 'Инженерный',
    research: 'Научный', service: 'Сервисный', security: 'Охранный', bar: 'Бар', shipyard: 'Верфь', destroyer: 'Эсминец', cruiser: 'Крейсер',
    battleship: 'Линкор', carrier: 'Авианосец', gunship: 'Канонерка', bomber: 'Бомбардировщик', support: 'Поддержка',
    capital: 'Капитальный', detective: 'Детективный', stealth: 'Стелс',
  },
  engine: {
    apu: 'ВСУ', plasma: 'Плазма', uranium: 'Уран', ame: 'ДАМ', solar: 'Солнечные панели', welding: 'Сварочное топливо',
    bananium: 'Бананиум', teg: 'ТЭГ', fusion: 'Термояд', antimatter: 'Антиматерия', battery: 'Батареи',
    supermatter: 'Суперматерия', tesla: 'Тесла', singularity: 'Сингулярность', rtg: 'РИТЭГ',
  },
  group: {
    shipyard: 'Верфь', security: 'СБ', blackmarket: 'Чёрный рынок', expedition: 'Экспедиции', custom: 'Кастом',
    syndicate: 'Синдикат', scrap: 'Утиль', medical: 'Медицина', civilian: 'Гражданские', company: 'Компании',
  },
};

/** Label of an enum value: "Средний" for category Medium; the value itself when it is unknown. */
export function enumLabel(kind, v) {
  if (v === null || v === undefined) return '';
  return (DICT[kind] || {})[String(v).toLowerCase()] || String(v);
}
