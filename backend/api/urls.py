from django.urls import path
from . import views

urlpatterns = [
    # LLM / Generative endpoints
    path('generate', views.generate, name='generate'),
    path('chat', views.chat, name='chat'),
    path('summarize', views.summarize, name='summarize'),
    path('embeddings', views.embeddings, name='embeddings'),

    # Permanent Tab Storage & High-Throughput Search Endpoints
    path('tabs/sync', views.sync_tabs, name='sync_tabs'),
    path('tabs/fts', views.fts_search, name='fts_search'),
    path('tabs/cards', views.get_cards, name='get_cards'),
    path('tabs/stats', views.get_stats, name='get_stats'),
    path('tabs/delete', views.delete_tabs, name='delete_tabs'),
    path('tabs/entity_query', views.entity_query, name='entity_query'),
    path('tabs/resolve_multi_hop', views.resolve_multi_hop, name='resolve_multi_hop'),
]

