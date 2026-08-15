from django.db import models, connection
from django.utils import timezone


class TabCard(models.Model):
    """Permanent computer on-disk storage for an indexed browser tab."""
    url_hash = models.CharField(max_length=64, primary_key=True, db_index=True)
    url = models.TextField()
    title = models.TextField(blank=True, default='')
    domain = models.CharField(max_length=255, db_index=True, blank=True, default='')
    category = models.CharField(max_length=100, db_index=True, blank=True, default='')
    tags = models.JSONField(default=list, blank=True)
    keywords = models.JSONField(default=list, blank=True)
    pseudo_doc = models.TextField(blank=True, default='')
    main_text = models.TextField(blank=True, default='')
    embedding = models.JSONField(null=True, blank=True)  # 384-dimensional vector list
    extraction_tier = models.CharField(
        max_length=30,
        choices=[
            ('hash_only', 'Hash Only'),
            ('local_ner', 'Local NER'),
            ('llm_enriched', 'LLM Enriched')
        ],
        default='local_ner'
    )
    extracted_at = models.DateTimeField(auto_now=True)
    last_seen_open_at = models.DateTimeField(default=timezone.now, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'tab_cards'
        ordering = ['-extracted_at']

    def __str__(self):
        return f"{self.title[:40]} ({self.domain})"

    def to_dict(self):
        return {
            'urlHash': self.url_hash,
            'url': self.url,
            'title': self.title,
            'domain': self.domain,
            'category': self.category,
            'tags': self.tags,
            'keywords': self.keywords,
            'pseudoDoc': self.pseudo_doc,
            'mainText': self.main_text,
            'embedding': self.embedding,
            'extractionTier': self.extraction_tier,
            'extractedAt': self.extracted_at.isoformat() if self.extracted_at else None,
            'lastSeenOpenAt': self.last_seen_open_at.isoformat() if self.last_seen_open_at else None,
        }


class TabEntity(models.Model):
    """Named entities linked to a tab card for structured and multi-hop queries."""
    url_hash = models.ForeignKey(
        TabCard,
        on_delete=models.CASCADE,
        related_name='entities',
        db_column='url_hash'
    )
    entity_name = models.CharField(max_length=255, db_index=True)
    entity_type = models.CharField(max_length=100, db_index=True)  # person, org, movie, award, tech, work, etc.
    confidence = models.FloatField(default=1.0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'tab_entities'
        indexes = [
            models.Index(fields=['entity_name', 'entity_type']),
        ]

    def __str__(self):
        return f"{self.entity_name} ({self.entity_type})"


class EntityResolutionCache(models.Model):
    """Cache for multi-hop entity resolution lookups (e.g. Oscar 2005 Best Actors)."""
    query_key = models.CharField(max_length=255, primary_key=True)
    resolved_entities = models.JSONField(default=list)
    resolved_at = models.DateTimeField(auto_now=True)
    ttl_seconds = models.IntegerField(default=2592000)  # 30 days default

    class Meta:
        db_table = 'entity_resolution_cache'

    def is_expired(self):
        age = (timezone.now() - self.resolved_at).total_seconds()
        return age > self.ttl_seconds


def setup_fts_tables():
    """Initializes SQLite FTS5 virtual table and synchronization triggers."""
    with connection.cursor() as cursor:
        cursor.execute("""
            CREATE VIRTUAL TABLE IF NOT EXISTS tab_fts USING fts5(
                url_hash UNINDEXED,
                title,
                domain,
                keywords,
                main_text,
                tokenize = 'porter unicode61'
            );
        """)
        # Triggers to keep FTS table in sync with tab_cards
        cursor.execute("""
            CREATE TRIGGER IF NOT EXISTS tab_cards_after_insert AFTER INSERT ON tab_cards BEGIN
                INSERT INTO tab_fts(url_hash, title, domain, keywords, main_text)
                VALUES (
                    new.url_hash,
                    new.title,
                    new.domain,
                    new.keywords,
                    new.main_text
                );
            END;
        """)
        cursor.execute("""
            CREATE TRIGGER IF NOT EXISTS tab_cards_after_update AFTER UPDATE ON tab_cards BEGIN
                DELETE FROM tab_fts WHERE url_hash = old.url_hash;
                INSERT INTO tab_fts(url_hash, title, domain, keywords, main_text)
                VALUES (
                    new.url_hash,
                    new.title,
                    new.domain,
                    new.keywords,
                    new.main_text
                );
            END;
        """)
        cursor.execute("""
            CREATE TRIGGER IF NOT EXISTS tab_cards_after_delete AFTER DELETE ON tab_cards BEGIN
                DELETE FROM tab_fts WHERE url_hash = old.url_hash;
            END;
        """)
