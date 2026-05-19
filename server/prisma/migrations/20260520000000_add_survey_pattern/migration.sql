-- AlterTable: survey_questionsにpatternとqIndexカラムを追加
ALTER TABLE "survey_questions" ADD COLUMN "pattern" TEXT NOT NULL DEFAULT 'A';
ALTER TABLE "survey_questions" ADD COLUMN "qIndex" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex
CREATE INDEX "survey_questions_module_pattern_idx" ON "survey_questions"("module", "pattern");

-- 既存データを削除して新しい質問を一括挿入
TRUNCATE TABLE "survey_questions" RESTART IDENTITY CASCADE;

-- ── bar パターンA ──
INSERT INTO "survey_questions" ("module","pattern","qIndex","body","options","hasFree","isActive","sortOrder","createdAt","updatedAt") VALUES
('bar','A',1,'最近、自分から誰かに話しかけたのはいつですか。','["今日","数日前","思い出せない","自分からはあまり話しかけない"]',true,true,1,NOW(),NOW()),
('bar','A',2,'今日、自分の肩書きや職業を話しましたか。','["話した","聞かれたから話した","話さなかった","そういう話にならなかった"]',true,true,2,NOW(),NOW()),

-- ── bar パターンB ──
('bar','B',1,'一人でいる時間は、最近多いですか。','["多い","どちらかといえば多い","どちらかといえば少ない","少ない"]',true,true,3,NOW(),NOW()),
('bar','B',2,'今日、名前を知らない人と話しましたか。','["話した","少し話した","話さなかった","話しかけられた"]',true,true,4,NOW(),NOW()),

-- ── bar パターンC ──
('bar','C',1,'最近、予定していなかった会話が生まれたのはいつですか。','["今日","最近あった","しばらくない","あまり記憶にない"]',true,true,5,NOW(),NOW()),
('bar','C',2,'今日、自分について何か話しましたか。','["結構話した","少し話した","ほとんど話さなかった","聞く側だった"]',true,true,6,NOW(),NOW()),

-- ── desk パターンA ──
('desk','A',1,'最近、何もしない時間を意図的に作れていますか。','["作れている","たまに作れる","あまり作れていない","作り方がわからない"]',true,true,7,NOW(),NOW()),
('desk','A',2,'今日、作業や展示から脱線しましたか。','["かなりした","少しした","しなかった","脱線が本題になった"]',true,true,8,NOW(),NOW()),

-- ── desk パターンB ──
('desk','B',1,'最近、誰かのやっていることをただ眺めた経験はありますか。','["よくある","たまにある","あまりない","今日が久しぶり"]',true,true,9,NOW(),NOW()),
('desk','B',2,'今日、他の人の作業や展示が気になりましたか。','["かなり気になった","少し気になった","あまり気にならなかった","自分のことで精一杯だった"]',true,true,10,NOW(),NOW()),

-- ── desk パターンC ──
('desk','C',1,'普段、自分のためだけに使っている時間はありますか。','["ある","あるような気がする","あまりない","よくわからない"]',true,true,11,NOW(),NOW()),
('desk','C',2,'今日この場で、想定していなかったことが起きましたか。','["起きた","少し起きた","特になかった","全部が想定外だった"]',true,true,12,NOW(),NOW()),

-- ── topic パターンA ──
('topic','A',1,'最近、誰かに自分の考えを話す機会はありますか。','["よくある","たまにある","あまりない","SNSでは書くけど話さない"]',true,true,13,NOW(),NOW()),
('topic','A',2,'今日、自分の解釈が誰かの言葉で変わりましたか。','["変わった","少し揺らいだ","変わらなかった","もっと強くなった"]',true,true,14,NOW(),NOW()),

-- ── topic パターンB ──
('topic','B',1,'最近、考えが止まらなくて眠れなかったことはありますか。','["よくある","たまにある","あまりない","最近はよく眠れている"]',true,true,15,NOW(),NOW()),
('topic','B',2,'今日の話題は、帰ってからも頭に残りそうですか。','["残りそう","たぶん残る","残らないと思う","もう残っている"]',true,true,16,NOW(),NOW()),

-- ── topic パターンC ──
('topic','C',1,'普段、自分の意見を最後まで言い切れることはありますか。','["よくある","相手による","あまりない","言い切る前に変わってしまう"]',true,true,17,NOW(),NOW()),
('topic','C',2,'今日、持ち寄ったもの（本・記事・問い）は誰かと交差しましたか。','["交差した","予想外の方向に転がった","あまり交差しなかった","自分の中で交差した"]',true,true,18,NOW(),NOW());
