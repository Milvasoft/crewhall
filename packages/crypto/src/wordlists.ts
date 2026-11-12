/**
 * Passphrase word lists (design 8.9 "Parola cümlesi"), written for this project: short, common,
 * easy-to-type words. Entropy per word is log2(list length); the generator reports it.
 */

const EN = `
able acid acorn actor adapt adobe after agent agile album alley alpha amber ample angle ankle
apple april apron arena argue armor arrow aside atlas audio autumn avoid awake award badge
bagel baker balmy bamboo banjo barley basin basket beach beacon beard beaver bench berry bicycle
birch bison blade blanket blaze blend bloom blossom board bonus boost border bottle bounce bracket
brave bread breeze brick bridge bright brook broom brush bubble bucket buddy budget buffalo bugle
bundle bunny burger butter button cabin cable cactus camel camera canal candle canoe canvas canyon
captain carbon cargo carpet carrot castle cattle cave cedar celery cello cement cereal chalk
champion chapter charm cheese cherry chess chest chimney choir cider cinema circle citrus civic
clarity clever cliff climb clock cloud clover coast cobalt cocoa coconut coffee comet comic
compass concert copper coral corner cosmic cotton couch cougar country cousin cradle crane crater
crayon cricket crisp crown crystal cube cupcake curious curtain cushion cycle dairy daisy dance
dawn debut decade deer delta denim desert detail diamond diary dinner dish dolphin domain donkey
dragon drama drawer dream drift drum duck dune dusk eagle early earth easel echo eclipse eight
elbow elder elegant elephant elevator elk ember emerald empire energy engine enjoy envoy equal
escape essay estate evening exact exotic fabric falcon family fancy fantasy farmer feather fennel
ferry festival fiber fiction field fiesta figure filter finch firefly fiscal flame flavor fleet
flint float flock floral flute focus folder forest fossil fountain fox fragile frame freckle
fresh friend frost fruit fudge galaxy gallery garden garlic gentle geyser ginger giraffe glacier
glide globe glove golden gopher gospel gourmet grain granite grape graph grass gravel green
griffin grove guitar gusto habit hammer hamster harbor harmony harvest hazel helmet herald hermit
hiking hobby honey hopper horizon hornet hotel humble humor hunter husky iceberg icon idea igloo
image impact indigo inlet insect island ivory jacket jaguar jasmine jelly jewel jigsaw jockey
journal journey jungle juniper kayak kernel kettle kingdom kitchen kitten kiwi koala ladder lagoon
lantern laptop lasso latte lavender lawn layer leaf legend lemon lentil leopard letter lilac lime
linen lion liquid little lizard llama lobster locket lodge lotus lucky lunar lyric magnet mango
maple marble market meadow medal melody melon mentor merit meteor mint mirror mitten mobile modest
monkey moose morning mosaic motor mountain muffin mural museum mushroom music mustard napkin
narrow nature navy nectar needle nest nickel night noble noodle north notebook novel nugget nutmeg
oasis ocean octave olive omega onion opal opera orange orbit orchard orchid organ otter outdoor
oven owl oxygen oyster paddle palace panda panther paper parade parrot pasta pastel patio peach
peanut pearl pebble pecan pelican pencil pepper piano picnic pigeon pillow pilot pine pioneer pixel
pizza planet plaza plum poetry polar pony popcorn poppy portal potato pottery prairie prism
pudding puffin pulse pumpkin puppet puzzle quail quartz quest quiet quilt rabbit raccoon radar
radio rainbow raisin ranch raven razor recipe reef relay remedy rhythm ribbon rice riddle ripple
river robin rocket rodeo roof rose rover ruby rugby saddle saffron sail salad salmon salsa sample
sandal satin saturn savanna scarf scholar scooter season secret sequel shadow shelf shell shield
shrimp signal silver simple siren sketch skiing sky slate sleigh slogan smile snack snail sonnet
spark sparrow spice spider spinach sponge spring spruce square squid stable stadium star statue
steam stone story strawberry stream studio sugar summit sunny sunset super surf swamp swan sweater
symbol syrup table tablet taco talent tango teacup teapot temple tennis thimble thunder ticket
tiger timber toast tomato topaz torch tortoise toucan tower tractor trail travel treasure tribe
trophy tropic trumpet tulip tundra tunnel turkey turtle tuxedo twilight umbrella unicorn unity
upbeat urban utopia valley vanilla velvet venture verse violet violin virtue vision vivid volcano
voyage waffle wagon walnut walrus wander warm wasabi water wave weasel wheat whisper whistle willow
window winter wizard wombat wonder woods yacht yard yellow yogurt zebra zenith zephyr zigzag zinc
zone acrobat admiral alpine anchor antler aquarium arcade archer attic avocado azure backpack
balcony ballet banana banner barrel basil battery bazaar beetle biscuit blizzard blueberry bonfire
boulder bowtie breakfast brownie buckle burrow cafe calendar camping candy caramel cardigan carnival
cashew catalog cauldron chamber cheetah chestnut chipmunk chorus cinnamon clarinet cobbler compost
cookie cottage coyote crocodile croissant crumble cucumber cymbal dandelion dessert dinosaur doodle
doorbell dragonfly dumpling eggplant emblem espresso evergreen fern fireplace flamingo flannel
footpath freeway gazebo gingham goblet gondola gravy hammock hedgehog hibiscus hilltop hockey
hummus jamboree jellyfish kangaroo keyboard lemonade lighthouse limestone lullaby macaron mandolin
marigold marshmallow meerkat milkshake mistletoe moonlight mosquito nightingale oatmeal orchestra
ostrich pancake paprika parsley passport peacock penguin peppermint pinecone pistachio platypus
porcupine pretzel quokka radish raspberry reindeer rosemary sailboat sandcastle seahorse snowflake
spaghetti starfish sunflower teardrop thistle toboggan treehouse trombone turnip vineyard walkway
waterfall watermelon wildflower woodpecker
`;

const TR = `
abla acele adalet adres afiyet ağaç ahenk ahşap akıl akrep akşam aktör alarm albüm alev alfabe
altın ambar ana anahtar anı anlam antre arı arkadaş armut aroma arşiv asker aslan ateş avcı
ayak ayçiçeği aydın ayna ayva bahar bahçe bakır balık balkon balon bambu bando banka baraj
barış başak baykuş bayrak bebek bekçi benzin beyaz bilet bilgi bina bisiklet biber bitki bulut
boğaz boncuk bostan boya böcek börek buhar buket bulgur burun buzdağı cadde cam ceket ceviz
cetvel cevher ceylan cilt cimri ciğer coşku cömert cumba çadır çakıl çalgı çamur çanta çatı
çay çekiç çelik çember çeşme çiçek çiftlik çikolata çilek çimen çini çorap çorba çubuk dağ
dalga damla dans davul defne defter deniz dere derin dev deve dilek dinamo dolap dolu domates
dost duman durak duvar düdük dünya düğme düş ekmek ekin elma elmas emek enerji erik eser
eşarp etek evren fakir fanus fare fasulye fener fıstık fidan fikir filiz fincan fırça fırın
fırtına fiyonk flüt fok gaga galeri gemi gece gelincik gezgin gezegen gitar göl gölge gömlek
gönül güneş gurur gümüş güzel hamak hamur harita hasat hava havuç hayal hazine hediye hece
helva hisar hız horoz huzur ılık ırmak ışık ısırgan ıhlamur iğne ilham ilik incir inci irmik
iskele istasyon iyilik izci kabak kadife kafes kahve kalem kale kamyon kanarya kanat kantin
kapı kaplan kaptan karınca karpuz kartal kasaba kasırga kavak kavun kayak kaya kayık kazak
kedi keklik kelebek kemer kemik kepçe kervan kese keşif kilim kiraz kitap koala kova koyun
köprü köpük kömür kral kumsal kurabiye kuzu kule kum kumru kupa kuş kutu kuyu lale lamba
lavanta leylak liman limon lokum maden mahalle makas manav mandalina mantar marul masa masal
mavi maydanoz mektup melodi menekşe merak mercan merdiven mermer mevsim meydan meyve mısır mimar
minder misafir mozaik mum murat müzik nane nar narin nehir nergis nisan nokta not ocak okul
okyanus olta orman ozan oyun öğle ördek örgü örtü özlem palamut palmiye pamuk panda papatya
papağan paraşüt parfüm park pasta patates pazar peçete pembe pencere peynir pırasa pide pilot
pinyon pirinç portakal posta pusula radyo rakam ray reçel rehber renk resim rüya rüzgar saat
sabah sabun saksı salata salkım saman sandal sandık sanat saray sardalya sarı sarmaşık sayfa
sedir sefer selam semaver sepet serçe sergi sevgi sıcak sınıf sincap simit sinema sirke sis
sofra sokak somun sonbahar soğan sohbet söğüt su sucuk sünger şafak şahin şair şal şapka şarkı
şato şehir şeker şelale şemsiye şerbet şimşek şirin tabak tahta takvim tarla tatlı tavşan tavuk
tebessüm tekne telefon tencere tepe terazi tilki toprak torba tohum topaz tuğla tulum turna
turşu tuz uçak uçurtma ufuk umut usta uyku ülke üzüm vadi vagon vapur vazo yaban yağmur yaka
yakut yaprak yarış yastık yayla yaz yelek yelken yemiş yengeç yeşil yıldız yolcu yorgan yosun
yumurta yunus yürek zambak zaman zeytin zil zincir zirve zümrüt akasya alkış anason armağan
atkı avize ayran badem baklava bakla balina basamak batik baston bazlama beşik biblo bilye
bostancı bozkır buğday bülbül çakır çardak çekirdek çınar çıra dantel deniz feneri dinlence
doruk ebru efsane eldiven ezgi fesleğen fındık gelin gökkuşağı gümüşi halı harman hurma ışıltı
kağıt kaktüs kanepe karanfil kavanoz kayısı kestane kırlangıç kilit kozalak kumbara kurdele
lavaş leblebi mandolin mangal menteşe mercimek minare nilüfer orkide palet pancar pekmez
pelikan peri pestil petek reyhan sahil saklambaç salep sarımsak semizotu sepetçi tarçın tespih
yalı yasemin zencefil
`;

function build(text: string): readonly string[] {
  return Object.freeze([...new Set(text.split(/\s+/).filter((w) => /^[a-zçğıöşü]+$/.test(w)))]);
}

export const WORDLISTS = { en: build(EN), tr: build(TR) } as const;
export type WordlistLang = keyof typeof WORDLISTS;
